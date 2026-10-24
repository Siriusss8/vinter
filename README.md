# Vinter

A small open-source browser extension (Chrome and Firefox, Manifest V3) that adds a **Seller** filter to Vinted's search page, styled like the native filter chips.

| Filter | Source |
| --- | --- |
| Minimum reviews (0 = "no reviews" filter) | `feedback_count` from `/api/v2/users/{id}` |
| Minimum rating | `feedback_reputation` (0–1, shown as 0–5 stars) |
| Minimum account age | estimated from the user ID (see below) |
| Last seen | `last_loged_on_ts` |
| Recent reviews | average of the 10 latest non-automatic reviews (`/api/v2/user_feedbacks`) |
| Reused photos (experimental) | perceptual hash of cover photos, matched across different sellers |

Filtered listings can be **hidden** or **dimmed**. Dimmed cards get a label with the reason, e.g. "0 reviews · New account (~4 months)". The UI follows the page language (it, fr, de, es, en) and settings sync across tabs.

## Install (development)

```sh
npm install
npm run start:chrome    # or: npm run start:firefox
npm run lint
npm run build           # zip in dist/
```

You can also load it by hand. In Chrome, open `chrome://extensions`, enable Developer mode, click "Load unpacked" and pick `vinter/`. In Firefox, open `about:debugging` → This Firefox → "Load Temporary Add-on" and pick `vinter/manifest.json`.

## How it works

- `src/hook.js` runs in the page's world. It passes along the catalog API responses Vinted already fetches, so the extension learns which seller owns each listing. As a fallback it reads the same data from React's props on the cards. It also signals when React hydration is done. Changing the DOM before that point makes Vinted's React app throw error #418.
- `src/content.js` adds the chip and panel by cloning a native filter chip. It looks up each seller once and caches the result for 24 hours.
  - Every seller on the current page is checked, so listings don't vanish while you scroll. Cards within about one screen of the viewport go first.
  - When the page is done, it fetches the next results page (the pagination link's HTML, one request) and looks up its sellers ahead of time. In testing, about 80% of page 2's sellers were already known when it opened. The rest differ because Vinted reshuffles results slightly.
  - Lookups that nothing needs any more (filters changed, user paginated away) are dropped. Lookups that keep failing are skipped for 10 minutes so they can't stall the rest.
  - Hidden tabs pause and give their turn to visible tabs.
  - "Recent reviews" asks for only written reviews (`by=user`, 10 per request). It is skipped for sellers with 10 reviews or fewer, where the lifetime rating is used instead, and only fetched again when the seller's review count changes.
- `src/background.js` runs one shared limiter (`lib/limiter.js`) for all Vinted tabs, so more tabs don't mean more traffic. Tabs ask it for a slot before each API call and report the outcome. On-screen cards get at most 1 request per second. Off-screen and next-page work runs at half that rate, because processing a whole page at 1 request per second got 429s after about a minute. On a 429 it doubles the interval and pauses, using `Retry-After` when Vinted sends it (in testing it was 60 s). A Cloudflare challenge pauses it for at least 2 minutes. The requests themselves are still made from the tab so they carry the site's cookies. The background script also hashes listing photos: Vinted's image CDN sends no CORS headers, so only the extension context can read pixels.
- `src/lib/` contains pure modules (extract, filters, age, dhash, queue, i18n) with no browser dependencies.

### Account age

Vinted does not expose a creation date. User IDs are allocated in increasing order, so `lib/age.js` maps the ID to a date by interpolating between sampled anchors. Anchors are dated by the earliest proof that the account existed. Every looked-up profile also tightens the estimate. Estimates are upper bounds, so they err toward "younger". Around late 2025 new IDs jumped from about 3.1e8 to about 3.1e9, and the table accounts for that. Expect the estimate to be off by a few weeks, and refresh the table if Vinted changes how it allocates IDs.

## Limitations

- Account age is an estimate.
- The first time a seller is seen it costs one request (two with "Recent reviews" for sellers with more than 10 reviews). On-screen cards are decided within about 20 seconds. A whole fresh page of about 95 sellers takes around 3 minutes, and the next page about as long again in the background. Repeat sellers come from the cache.
- Preparing the next page downloads its HTML once (about 3.5 MB).
- Reused-photo detection only compares listings you have loaded in this tab. Treat matches as a hint: popular items share stock photos.
- The extension relies on Vinted's `data-testid` attributes and internal API, both of which can change without notice.

## Ideas for other signals

These were checked against the live API and look feasible:

- **Review trend:** compare the recent average with the lifetime one, e.g. a 4.9 lifetime rating whose last 10 reviews average 3.0. The data is already fetched for the "Recent reviews" filter.
- **Dormant account reactivated:** the oldest review is years old, nothing happened in between, and suddenly there are many new listings. Needs one more review page per seller.
- **Verification:** `verification.google/facebook` with their `verified_at` dates.
- **Bulk sellers:** a high `item_count` on a very young account.
- **Duplicate descriptions:** shingle and MinHash titles/descriptions across sellers, the same way photos are handled. Descriptions are only on item pages, so this costs a request per listing.

## Privacy

There are no analytics and no external servers. The extension only calls the Vinted site you are browsing, from your browser. Settings and the seller cache stay in `chrome.storage.local`.

## License

MIT
