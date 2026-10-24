// Content script: injects the "Seller" filter into Vinted's filter bar, looks up
// sellers (cached, rate-limited) and hides or dims listings that fail the filters.
(() => {
  'use strict';
  const { i18n, extract, age, filters, dhash, queue, limiter: limiterLib } = globalThis.Vinter;
  const ext = globalThis.chrome;

  const SELLER_TTL = 24 * 3600 * 1000;
  const MISSING_TTL = 6 * 3600 * 1000;
  const MAX_CACHED_SELLERS = 5000;
  // Pacing is decided by the shared limiter in the background worker; this is only a
  // per-tab floor in case the worker is unreachable.
  const LOCAL_FLOOR = 1000;
  // Every card on the page is checked; cards within one screen of the viewport go first.
  const NEAR_MARGIN = '100% 0px';
  // Lower runs first. The shared limiter also uses these to order work across tabs.
  const P = Object.freeze({
    nearProfile: 0,
    nearRecent: 1,
    pageProfile: 2,
    pageRecent: 3,
    nextPage: 4, // HTML of the next results page
    nextProfile: 5,
    nextRecent: 6,
  });
  const LAST_PAGE_PRIORITY = P.pageRecent;
  const FETCH_TIMEOUT = 20000;
  // A lookup that keeps failing is skipped for a while, so it can't hold back the
  // rest of the page or the next-page preparation.
  const GIVE_UP_MS = 10 * 60 * 1000;
  const ATTR = 'data-vinter';
  const LABEL_ATTR = 'data-vinter-label';
  const ITEM_ATTR = 'data-vinter-item';

  // Firefox runs content-script fetch() with the extension's principal; content.fetch
  // behaves like the page (same origin, same cookies). Chrome already does that.
  const pageFetch =
    typeof globalThis.content === 'object' && globalThis.content && typeof globalThis.content.fetch === 'function'
      ? globalThis.content.fetch.bind(globalThis.content)
      : globalThis.fetch.bind(globalThis);

  const lang = i18n.detectLang(document.documentElement.lang);
  const t = i18n.translator(lang);

  const state = {
    settings: filters.sanitize(null),
    sellers: new Map(), // sellerId -> normalized seller | { missing: true, fetchedAt }
    itemSeller: new Map(), // itemId -> sellerId
    estimator: new age.AgeEstimator(),
    photos: new dhash.PhotoIndex(),
    photoFlags: new Set(), // itemIds with a cross-seller photo match
    photoRequested: new Set(),
    nearCards: new Set(), // card elements within NEAR_MARGIN of the viewport
    wants: new Map(), // job key -> { priority, start(priority) }, rebuilt on each pass
    failed: new Map(), // job key -> time it last gave up
    pagePending: 0, // lookups still needed for cards on this page
    // Next results page: { href, status: 'queued'|'ready'|'failed', sellers: number[] }
    next: null,
    hiddenCount: 0,
    unresolved: [], // itemIds on screen without a known seller (last pass)
    pausedUntil: 0, // shared limiter pause, as last reported by the background
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const extensionAlive = () => Boolean(ext.runtime && ext.runtime.id);

  // Wait for a slot from the background limiter. If the worker restarts mid-wait the
  // message fails; asking again wakes it and its restored state keeps any pause.
  async function acquireSlot(job) {
    for (;;) {
      if (requests.suspended) return; // tab hidden: queue will not run anything
      try {
        const res = await ext.runtime.sendMessage({ type: 'vinter:slot', priority: job ? job.priority : 1 });
        if (res && Number.isFinite(res.pausedUntil)) state.pausedUntil = res.pausedUntil;
        if (res && res.granted) return;
      } catch (err) {
        if (!extensionAlive()) throw err; // extension reloaded: fall back to local floor
      }
      await sleep(1000);
    }
  }

  function report(outcome, retryAfter = null) {
    ext.runtime
      .sendMessage({ type: 'vinter:report', outcome, retryAfter })
      .then((status) => {
        if (status && Number.isFinite(status.pausedUntil)) {
          state.pausedUntil = status.pausedUntil;
          scheduleStatus();
        }
      })
      .catch(() => {});
  }

  const requests = new queue.RequestQueue({
    minInterval: LOCAL_FLOOR,
    acquire: acquireSlot,
    onChange: () => scheduleStatus(),
  });

  // Hidden tabs make no requests and give their slot to other tabs.
  function syncVisibility() {
    if (document.visibilityState === 'hidden') {
      requests.suspend();
      ext.runtime.sendMessage({ type: 'vinter:withdraw' }).catch(() => {});
    } else {
      requests.resume();
    }
  }
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
  const photoQueue = new queue.RequestQueue({ minInterval: 50 });

  // ---------------------------------------------------------------- storage

  let persistTimer = 0;
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const now = Date.now();
      const entries = [...state.sellers.values()]
        .filter((s) => now - s.fetchedAt < SELLER_TTL)
        .sort((a, b) => b.fetchedAt - a.fetchedAt)
        .slice(0, MAX_CACHED_SELLERS);
      ext.storage.local.set({ sellers: entries, ageLearned: state.estimator.toJSON() }).catch(() => {});
    }, 2000);
  }

  async function load() {
    const data = await ext.storage.local.get(['settings', 'sellers', 'ageLearned']).catch(() => ({}));
    state.settings = filters.sanitize(data.settings);
    state.estimator = new age.AgeEstimator(Array.isArray(data.ageLearned) ? data.ageLearned : []);
    const now = Date.now();
    for (const s of Array.isArray(data.sellers) ? data.sellers : []) {
      if (s && s.id && now - s.fetchedAt < (s.missing ? MISSING_TTL : SELLER_TTL)) state.sellers.set(s.id, s);
    }
  }

  function saveSettings(next) {
    state.settings = filters.sanitize(next);
    ext.storage.local.set({ settings: state.settings }).catch(() => {});
    onSettingsChanged();
  }

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = filters.sanitize(changes.settings.newValue);
    if (JSON.stringify(next) === JSON.stringify(state.settings)) return;
    state.settings = next;
    onSettingsChanged();
  });

  // --------------------------------------------------------- item -> seller

  function learnPairs(pairs) {
    let added = false;
    for (const [item, seller] of pairs) {
      if (state.itemSeller.get(item) !== seller) {
        state.itemSeller.set(item, seller);
        added = true;
      }
    }
    if (added) scheduleScan();
  }

  let markReady;
  const pageReady = new Promise((resolve) => (markReady = resolve));

  // Messages from hook.js (page world). Only structural data is accepted.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__vinter !== 1) return;
    const msg = e.data;
    if (msg.type === 'ready') markReady();
    else if (msg.type === 'body' && typeof msg.body === 'string') {
      let pairs;
      try {
        pairs = extract.collectPairs(JSON.parse(msg.body));
      } catch {
        pairs = extract.pairsFromFlightText(msg.body);
      }
      learnPairs(pairs);
    } else if (msg.type === 'pairs' && Array.isArray(msg.pairs)) {
      learnPairs(
        msg.pairs.filter(
          (p) => Array.isArray(p) && Number.isSafeInteger(p[0]) && p[0] > 0 && Number.isSafeInteger(p[1]) && p[1] > 0
        )
      );
    }
  });

  // Ask hook.js to read sellers from React props for cards we could not resolve.
  const fiberAsked = new Set();
  function requestFiberPairs(itemIds) {
    const ids = itemIds.filter((id) => !fiberAsked.has(id));
    if (!ids.length) return;
    ids.forEach((id) => fiberAsked.add(id));
    window.postMessage({ __vinterCmd: 'pairs', ids }, location.origin);
  }

  // ------------------------------------------------------------- API access

  // Vinted sometimes leaves requests hanging when it is throttling; without a timeout
  // one stuck request would block the serial queue for good. (Racing instead of
  // aborting: an AbortSignal from this script can't be handed to Firefox's content.fetch.)
  function withTimeout(promise, ms = FETCH_TIMEOUT) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Fetch from the page's origin and report the outcome to the shared limiter, so
  // all tabs slow down together. Throws RetryLater for anything worth retrying.
  async function limitedFetch(url, accept) {
    let res;
    try {
      res = await withTimeout(pageFetch(url, { credentials: 'include', headers: { accept } }));
    } catch (err) {
      report(String(err && err.message) === 'timeout' ? 'limited' : 'error');
      throw new queue.RetryLater(String(err));
    }
    const type = res.headers.get('content-type') || '';
    if (res.ok || res.status === 404) {
      report('ok');
      return { res, type };
    }
    const retryAfter = limiterLib.parseRetryAfter(res.headers.get('retry-after'));
    if (res.headers.get('cf-mitigated') === 'challenge' || (res.status === 403 && !type.includes('json'))) {
      report('challenge', retryAfter);
    } else if (res.status === 429 || res.status === 403) {
      report('limited', retryAfter);
    } else {
      report('error', retryAfter);
    }
    throw new queue.RetryLater(`HTTP ${res.status}`);
  }

  async function getJson(path) {
    const { res, type } = await limitedFetch(new URL(path, location.origin).href, 'application/json');
    if (res.status === 404) return null;
    if (!type.includes('json')) throw new queue.RetryLater(`unexpected ${type}`);
    try {
      return await withTimeout(res.json());
    } catch (err) {
      throw new queue.RetryLater(String(err));
    }
  }

  function sellerFresh(id) {
    const s = state.sellers.get(id);
    return s && Date.now() - s.fetchedAt < (s.missing ? MISSING_TTL : SELLER_TTL) ? s : null;
  }

  // A pass over the page records what it needs; applyAll() then queues new jobs,
  // re-prioritizes existing ones and drops jobs nothing needs any more.
  function want(key, priority, start) {
    const failedAt = state.failed.get(key);
    if (failedAt && Date.now() - failedAt < GIVE_UP_MS) return;
    const w = state.wants.get(key);
    if (!w || priority < w.priority) state.wants.set(key, { priority, start });
  }

  // Final rejection after all retries (cancellation is not a failure).
  const onJobError = (key) => (err) => {
    if (!(err instanceof queue.Cancelled)) {
      state.failed.set(key, Date.now());
      scheduleApply(); // recount what this page still needs
    }
  };

  function wantSeller(id, priority) {
    want(`u${id}`, priority, (p) => requestSeller(id, p));
  }

  function wantRecent(seller, priority) {
    want(`f${seller.id}`, priority, (p) => requestRecent(seller, p));
  }

  // Seller filters that apply to a seller we have (or need) data for.
  function wantSellerWork(sellerId, profilePriority, recentPriority, s) {
    const seller = sellerFresh(sellerId);
    if (!seller) {
      wantSeller(sellerId, profilePriority);
      return null;
    }
    if (seller.missing) return null;
    const ageDays = s.minAgeDays > 0 ? state.estimator.ageDays(sellerId, Date.now(), seller.evidence) : null;
    const result = filters.evaluate(seller, s, { ageDays });
    if (result.needsRecent) wantRecent(seller, recentPriority);
    return result;
  }

  function requestSeller(id, priority) {
    if (sellerFresh(id)) return;
    requests
      .add(`u${id}`, async () => {
        const json = await getJson(`/api/v2/users/${id}`);
        const now = Date.now();
        const prev = state.sellers.get(id);
        if (!json || !json.user) {
          state.sellers.set(id, { id, missing: true, fetchedAt: now });
        } else {
          const evidence = age.evidenceFromUser(json.user);
          state.estimator.learn(id, evidence, now);
          const next = filters.normalizeUser(json.user, evidence, now);
          // Keep the recent-review average; evaluate() refetches it only if the
          // review count changed since it was computed.
          if (prev && prev.recent) next.recent = prev.recent;
          state.sellers.set(id, next);
        }
        persistSoon();
        scheduleApply();
      }, priority)
      .catch(onJobError(`u${id}`));
  }

  function requestRecent(seller, priority) {
    requests
      .add(`f${seller.id}`, async () => {
        // by=user excludes Vinted's automatic reviews, so 10 entries = 10 written reviews.
        const json = await getJson(
          `/api/v2/user_feedbacks?user_id=${seller.id}&page=1&per_page=${filters.RECENT_WINDOW}&by=user`
        );
        const current = state.sellers.get(seller.id);
        if (current && !current.missing) {
          current.recent = { ...filters.recentFromFeedbacks(json && json.user_feedbacks), reviews: current.reviews };
          persistSoon();
          scheduleApply();
        }
      }, priority)
      .catch(onJobError(`f${seller.id}`));
  }

  // ---------------------------------------------------------------- next page

  // Vinted's pagination "next" link. Its server-rendered HTML carries the same
  // item -> seller payload as the first page, so one request reveals every seller
  // there and the lookups can run before the user gets to it.
  function nextPageHref() {
    const link = document.querySelector('a[data-testid="catalog-pagination--next-page"][href]');
    if (!link || link.getAttribute('aria-disabled') === 'true') return null;
    try {
      const url = new URL(link.getAttribute('href'), location.href);
      return url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  function requestNextPage(href, priority) {
    requests
      .add(`n${href}`, async () => {
        const { res, type } = await limitedFetch(href, 'text/html');
        if (!state.next || state.next.href !== href) return; // user moved on meanwhile
        if (!res.ok || !type.includes('html')) {
          state.next.status = 'failed';
          return;
        }
        let html;
        try {
          html = await withTimeout(res.text(), 30000);
        } catch (err) {
          throw new queue.RetryLater(String(err));
        }
        const pairs = extract.pairsFromScripts([html]);
        learnPairs(pairs); // the items' sellers are then known as soon as page 2 renders
        state.next.sellers = [...new Set(pairs.values())];
        state.next.status = 'ready';
        scheduleApply();
      }, priority)
      .catch(() => {
        if (state.next && state.next.href === href && state.next.status === 'queued') state.next.status = 'failed';
      });
  }

  // Called after a pass; queues next-page work only once this page needs nothing.
  function wantNextPage(s) {
    const href = nextPageHref();
    if (!href || !filters.needsSeller(s)) {
      state.next = href && state.next && state.next.href === href ? state.next : null;
      return;
    }
    if (!state.next || state.next.href !== href) state.next = { href, status: 'queued', sellers: [] };
    if (state.pagePending > 0) return;
    if (state.next.status === 'queued') want(`n${href}`, P.nextPage, (p) => requestNextPage(href, p));
    else if (state.next.status === 'ready') {
      for (const id of state.next.sellers) wantSellerWork(id, P.nextProfile, P.nextRecent, s);
    }
  }

  function requestPhotoHash(itemId, sellerId, url) {
    if (state.photoRequested.has(itemId)) return;
    state.photoRequested.add(itemId);
    photoQueue
      .add(`p${itemId}`, async () => {
        const res = await ext.runtime.sendMessage({ type: 'vinter:dhash', url });
        if (!res || !res.hash) return;
        const matches = state.photos.add(itemId, sellerId, res.hash);
        if (matches.length) {
          state.photoFlags.add(itemId);
          for (const m of matches) state.photoFlags.add(m);
          scheduleApply();
        }
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------------ cards

  const CARD_SELECTOR = '[data-testid="grid-item"]';
  const ITEM_ID_RE = /^product-item-id-(\d+)$/;

  function cardItemId(card) {
    const el = card.querySelector('[data-testid^="product-item-id-"]');
    const m = el && ITEM_ID_RE.exec(el.getAttribute('data-testid'));
    return m ? Number(m[1]) : null;
  }

  // Near-viewport cards are checked first; the rest of the page follows.
  // Keyed by element because React can recycle a card node for another listing.
  const viewport = new IntersectionObserver(
    (entries) => {
      let gained = false;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (!state.nearCards.has(entry.target)) gained = true;
          state.nearCards.add(entry.target);
        } else {
          state.nearCards.delete(entry.target);
        }
      }
      scheduleApply(gained ? 0 : 400); // re-prioritize; losing "near" is not urgent
    },
    { rootMargin: NEAR_MARGIN }
  );
  const observed = new WeakSet();

  function reasonLabel(r) {
    switch (r.key) {
      case 'rReviews': return r.vars.n === 1 ? t('rReviewsOne') : t('rReviews', { n: r.vars.n });
      case 'rRating': return t('rRating', { x: i18n.formatRating(r.vars.rating, lang) });
      case 'rAge': return t('rAge', { x: i18n.formatDuration(r.vars.days, lang) });
      case 'rInactive': return t('rInactive', { x: i18n.formatDuration(r.vars.days, lang) });
      case 'rRecent': return t('rRecent', { x: i18n.formatRating(r.vars.rating, lang) });
      case 'rPhoto': return t('rPhoto');
      default: return '';
    }
  }

  function clearCard(card) {
    card.removeAttribute(ATTR);
    card.removeAttribute(LABEL_ATTR);
  }

  function applyCard(card) {
    const itemId = cardItemId(card);
    if (!itemId) return;
    if (card.getAttribute(ITEM_ATTR) !== String(itemId)) {
      card.setAttribute(ITEM_ATTR, String(itemId)); // React may recycle nodes
      clearCard(card);
    }
    if (!observed.has(card)) {
      observed.add(card);
      viewport.observe(card);
    }

    const s = state.settings;
    if (!filters.isActive(s)) return clearCard(card);

    const sellerId = state.itemSeller.get(itemId);
    if (!sellerId) {
      state.unresolved.push(itemId);
      return clearCard(card);
    }

    const near = state.nearCards.has(card);
    const reasons = [];
    if (filters.needsSeller(s)) {
      const result = wantSellerWork(
        sellerId,
        near ? P.nearProfile : P.pageProfile,
        near ? P.nearRecent : P.pageRecent,
        s
      );
      if (result) reasons.push(...result.reasons);
    }
    if (s.flagReusedPhotos) {
      const img = card.querySelector('img[data-testid$="--image--img"]');
      const src = img && (img.currentSrc || img.src);
      if (src) requestPhotoHash(itemId, sellerId, src);
      if (state.photoFlags.has(itemId)) reasons.push({ key: 'rPhoto' });
    }

    if (!reasons.length) return clearCard(card);
    card.setAttribute(ATTR, s.mode);
    card.setAttribute(LABEL_ATTR, reasons.map(reasonLabel).join(' · '));
    state.hiddenCount++;
  }

  function applyAll() {
    state.hiddenCount = 0;
    state.unresolved = [];
    state.wants = new Map();
    for (const card of state.nearCards) if (!card.isConnected) state.nearCards.delete(card);
    for (const card of document.querySelectorAll(CARD_SELECTOR)) applyCard(card);
    if (state.unresolved.length) requestFiberPairs(state.unresolved);

    state.pagePending = 0;
    for (const w of state.wants.values()) if (w.priority <= LAST_PAGE_PRIORITY) state.pagePending++;
    wantNextPage(state.settings);

    // Paginated away, filters changed or turned off: drop what nothing needs any more.
    requests.retain((job) => state.wants.has(job.key));
    for (const [key, w] of state.wants) {
      if (requests.has(key)) requests.setPriority(key, w.priority);
      else w.start(w.priority);
    }
    scheduleStatus();
  }

  // ------------------------------------------------------------- filter UI

  const UI_ID = 'vinter-seller-filter';
  const ui = { root: null, chip: null, label: null, panel: null, status: null, open: false };

  const OPTION_LABELS = {
    minReviews: (v) => (v ? t('atLeast', { x: v }) : t('any')),
    minRating: (v) => (v ? t('atLeast', { x: i18n.formatRating(v, lang) }) : t('any')),
    minAgeDays: (v) => (v ? t('atLeast', { x: i18n.formatDuration(v, lang) }) : t('any')),
    maxInactiveDays: (v) => (v ? t('within', { x: i18n.formatDuration(v, lang) }) : t('any')),
    minRecentRating: (v) => (v ? t('atLeast', { x: i18n.formatRating(v, lang) }) : t('any')),
    mode: (v) => t(v),
  };

  const ROWS = [
    ['minReviews', 'reviewsTitle', 'reviewsDesc'],
    ['minRating', 'ratingTitle', 'ratingDesc'],
    ['minAgeDays', 'ageTitle', 'ageDesc'],
    ['maxInactiveDays', 'activeTitle', 'activeDesc'],
    ['minRecentRating', 'recentTitle', 'recentDesc'],
    ['flagReusedPhotos', 'photosTitle', 'photosDesc'],
    ['mode', 'modeTitle', null],
  ];

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  // Locate Vinted's filter chips. data-testids are stable; hashed class names are not.
  function findFilterBar() {
    const triggers = document.querySelectorAll('button[data-testid^="catalog--"][data-testid$="-filter--trigger"]');
    if (!triggers.length) return null;
    const wrapperOf = (btn) => {
      let node = btn;
      while (node.parentElement && node.parentElement.querySelectorAll('button[data-testid$="-filter--trigger"]').length === 1) {
        node = node.parentElement;
      }
      return node; // highest ancestor that still contains only this trigger
    };
    const sort = document.querySelector('button[data-testid="catalog--sort-filter--trigger"]');
    const template = triggers[triggers.length - 1];
    const before = sort ? wrapperOf(sort) : null;
    const container = (before || wrapperOf(template)).parentElement;
    return container ? { container, before, template: wrapperOf(template) } : null;
  }

  function buildRow(key, titleKey, descKey) {
    const titleId = `vinter-${key}-title`;
    const descId = descKey ? `vinter-${key}-desc` : null;
    let control;
    if (key === 'flagReusedPhotos') {
      const input = el('input', {
        type: 'checkbox',
        id: `vinter-${key}`,
        'aria-labelledby': titleId,
        'aria-describedby': descId,
      });
      input.checked = state.settings.flagReusedPhotos;
      input.addEventListener('change', () => saveSettings({ ...state.settings, flagReusedPhotos: input.checked }));
      control = el('label', { class: 'web_ui__Checkbox__checkbox vinter-checkbox', for: `vinter-${key}` }, [
        input,
        el('span', { class: 'web_ui__Checkbox__button web_ui__Checkbox__button-left' }),
      ]);
    } else {
      control = el('select', {
        class: 'vinter-select',
        id: `vinter-${key}`,
        'aria-labelledby': titleId,
        'aria-describedby': descId,
      });
      for (const value of filters.OPTIONS[key]) {
        const opt = el('option', { value: String(value), text: OPTION_LABELS[key](value) });
        opt.selected = state.settings[key] === value;
        control.append(opt);
      }
      control.addEventListener('change', () => {
        const value = typeof filters.DEFAULTS[key] === 'number' ? Number(control.value) : control.value;
        saveSettings({ ...state.settings, [key]: value });
      });
    }
    return el('li', { class: 'vinter-row' }, [
      el('div', { class: 'web_ui__Cell__cell web_ui__Cell__default' }, [
        el('div', { class: 'web_ui__Cell__content' }, [
          el('div', { class: 'web_ui__Cell__heading' }, [
            el('div', { class: 'web_ui__Cell__title', id: titleId }, [
              el('span', { class: 'web_ui__Text__text web_ui__Text__title web_ui__Text__left', text: t(titleKey) }),
            ]),
          ]),
          descKey ? el('div', { class: 'web_ui__Cell__body', id: descId, text: t(descKey) }) : null,
        ]),
        el('div', { class: 'web_ui__Cell__suffix' }, [control]),
      ]),
    ]);
  }

  function buildPanel() {
    const list = el('ul', { class: 'vinter-list' }, ROWS.map((r) => buildRow(...r)));
    ui.status = el('p', {
      class: 'web_ui__Text__text web_ui__Text__caption web_ui__Text__left web_ui__Text__muted vinter-status',
      role: 'status',
      'aria-live': 'polite',
    });
    const reset = el('button', { type: 'button', class: 'web_ui__Button__button web_ui__Button__outlined web_ui__Button__medium web_ui__Button__primary vinter-btn' }, [
      el('span', { class: 'web_ui__Button__content' }, [el('span', { class: 'web_ui__Button__label', text: t('reset') })]),
    ]);
    reset.addEventListener('click', () => {
      saveSettings({ ...filters.DEFAULTS });
      rebuildPanel();
    });
    const done = el('button', { type: 'button', class: 'web_ui__Button__button web_ui__Button__filled web_ui__Button__medium web_ui__Button__primary vinter-btn' }, [
      el('span', { class: 'web_ui__Button__content' }, [el('span', { class: 'web_ui__Button__label', text: t('done') })]),
    ]);
    done.addEventListener('click', () => setOpen(false, true));

    return el('div', { role: 'none', class: 'u-fill-width u-zindex-large vinter-dropdown', hidden: true }, [
      el('div', {
        class: 'web_ui__Card__card web_ui__Card__elevated web_ui__Card__overflowAuto',
        role: 'dialog',
        id: `${UI_ID}-panel`,
        'aria-label': t('panel'),
      }, [
        el('div', { class: 'u-ui-padding-vertical-x-small' }, [
          el('div', { class: 'u-overflow-auto vinter-scroll' }, [list]),
          ui.status,
          el('div', { class: 'vinter-actions' }, [reset, done]),
        ]),
      ]),
    ]);
  }

  function rebuildPanel() {
    if (!ui.panel) return;
    const wasOpen = ui.open;
    const fresh = buildPanel();
    ui.panel.replaceWith(fresh);
    ui.panel = fresh;
    if (wasOpen) setOpen(true);
    updateStatus();
  }

  function buildChip(template) {
    // Clone a native filter chip so spacing, typography and the chevron match exactly.
    const root = template.cloneNode(true);
    root.id = UI_ID;
    root.querySelectorAll('[data-testid]').forEach((n) => n.removeAttribute('data-testid'));
    root.querySelectorAll('[aria-expanded]').forEach((n) => n.setAttribute('aria-expanded', 'false'));
    const chip = root.querySelector('button');
    if (!chip) return null;
    chip.classList.remove('web_ui__Chip__clicked');
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-controls', `${UI_ID}-panel`);
    chip.setAttribute('data-testid', 'vinter-seller-trigger');
    const label = chip.querySelector('.web_ui__Chip__text span') || chip.querySelector('.web_ui__Chip__text') || chip;
    const anchor = chip.parentElement;
    anchor.querySelectorAll(':scope > :not(button)').forEach((n) => n.remove()); // drop a cloned open dropdown
    anchor.classList.add('vinter-anchor');
    ui.panel = buildPanel();
    anchor.append(ui.panel);
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      setOpen(!ui.open);
    });
    ui.root = root;
    ui.chip = chip;
    ui.label = label;
    updateChip();
    return root;
  }

  function setOpen(open, restoreFocus = false) {
    ui.open = open;
    if (!ui.panel || !ui.chip) return;
    ui.panel.hidden = !open;
    ui.chip.setAttribute('aria-expanded', String(open));
    ui.chip.classList.toggle('web_ui__Chip__clicked', open);
    if (open) {
      ui.panel.style.left = '0px';
      const rect = ui.panel.getBoundingClientRect();
      const overflow = rect.right - (document.documentElement.clientWidth - 8);
      if (overflow > 0) ui.panel.style.left = `${-Math.min(overflow, rect.left - 8)}px`;
      updateStatus();
      const first = ui.panel.querySelector('select, input');
      if (first) first.focus({ preventScroll: true });
    } else if (restoreFocus) {
      ui.chip.focus({ preventScroll: true });
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (ui.open && ui.root && !ui.root.contains(e.target)) setOpen(false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (ui.open && e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false, true);
    }
  }, true);

  function updateChip() {
    if (!ui.label) return;
    const n = filters.activeCount(state.settings);
    ui.label.textContent = n ? `${t('chip')} (${n})` : t('chip');
    ui.chip.classList.toggle('vinter-chip-active', n > 0);
  }

  function updateStatus() {
    if (!ui.status || !ui.open) return;
    if (!filters.isActive(state.settings)) ui.status.textContent = t('statusOff');
    else if (state.pausedUntil > Date.now() && requests.size) ui.status.textContent = t('statusPaused');
    else {
      let text = t('status', { hidden: state.hiddenCount, pending: state.pagePending });
      const next = state.next;
      if (state.pagePending === 0 && next && next.status === 'ready') {
        const left = [...state.wants.values()].filter((w) => w.priority > LAST_PAGE_PRIORITY).length;
        text += ' · ' + (left ? t('statusNext', { pending: left }) : t('statusNextReady'));
      } else if (state.pagePending === 0 && next && next.status === 'queued') {
        text += ' · ' + t('statusNext', { pending: '…' });
      }
      ui.status.textContent = text;
    }
  }

  function ensureUi() {
    if (ui.root && ui.root.isConnected) return;
    const bar = findFilterBar();
    if (!bar) return;
    const root = buildChip(bar.template);
    if (!root) return;
    if (bar.before) bar.container.insertBefore(root, bar.before);
    else bar.container.append(root);
  }

  // -------------------------------------------------------------- scheduling

  let started = false; // no DOM writes until React has hydrated
  let scanFrame = 0;
  function scheduleScan() {
    if (!started || scanFrame) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = 0;
      ensureUi();
      applyAll();
    });
  }

  let applyTimer = 0;
  let applyDue = 0;
  function scheduleApply(delay = 0) {
    if (!started) return;
    const due = Date.now() + 120 + delay;
    if (applyTimer && applyDue <= due) return; // an earlier pass is already scheduled
    clearTimeout(applyTimer);
    applyDue = due;
    applyTimer = setTimeout(() => {
      applyTimer = 0;
      applyAll();
    }, due - Date.now());
  }

  let statusTimer = 0;
  function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      updateStatus();
    }, 200);
  }

  function onSettingsChanged() {
    updateChip();
    applyAll();
  }

  const mutations = new MutationObserver((records) => {
    for (const r of records) {
      // Ignore our own panel and attribute churn.
      if (ui.root && ui.root.contains(r.target)) continue;
      if (r.addedNodes.length || r.removedNodes.length) return scheduleScan();
    }
  });

  // -------------------------------------------------------------------- init

  // Touching React-managed DOM before hydration finishes makes React throw a
  // hydration error, so wait for hook.js to confirm React owns the page.
  function afterHydration() {
    window.postMessage({ __vinterCmd: 'ready' }, location.origin);
    return Promise.race([pageReady, new Promise((r) => setTimeout(r, 25000))]);
  }

  async function init() {
    learnPairs(extract.pairsFromScripts([...document.scripts].map((s) => s.textContent)));
    await Promise.all([load(), afterHydration()]);
    started = true;
    mutations.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
  }

  init().catch((err) => console.warn('[vinter]', err));
})();
