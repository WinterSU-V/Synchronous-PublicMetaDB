# Synchronous: PublicMetaDB (Stremio Addon)

Continue Watching, Watchlist, and any custom lists from your
[PublicMetaDB](https://publicmetadb.com) account, as Stremio catalogs —
browsable, and in whatever order you choose.

## How it works

- PMDB's list/resume endpoints only return `tmdb_id` + `media_type` — no
  poster, title, or IMDb ID. This addon enriches every item via the
  **TMDB API** (title, poster, IMDb ID), and caches results for 7 days
  (persisted to disk, so a server restart doesn't force a cold start).
- The addon is per-user: your PMDB key, TMDB key, and chosen catalogs
  (including their order) are packed into the install URL itself
  (base64). Nothing is stored server-side.

## Setup

```bash
npm install
npm start
```

This starts the server at `http://127.0.0.1:7000`.

## Using it

1. Open `http://127.0.0.1:7000/configure`.
2. **Connect** — paste your PMDB API key and TMDB API key, or import a
   previously-exported `.pmdbkeys` file. Click **Load my lists**.
3. **Lists** tab — every list you have, with posters (prefetched so
   expanding is instant). **Configuration** tab — tick which lists become
   Stremio catalogs, drag ⠿ (or use ▲▼) to set their order, then
   **Generate install link** and paste the manifest URL into Stremio →
   Addons → search bar.
4. The **⚙ menu** lets you export your keys (optionally with your list
   selection/order) as an encrypted file, or sign out.

## Catalog naming (avoiding duplicate type tags)

Stremio's Home screen appears to auto-disambiguate two catalogs from the
same addon when they'd otherwise display with the *identical* name — it
appends "- Series"/"- Movies" itself. Since every configured list becomes
two Stremio catalogs (one per content type) and both used to get the exact
same raw name, this meant:

- A plainly-named list ("Watchlist") got one clean auto-added suffix per
  side — fine.
- A list you'd already named with a type word yourself (e.g. "Watching -
  Series") got Stremio's auto-suffix stacked *on top* of your own wording
  — "Watching - Series - Series".

The fix (`src/addon.js`, `catalogDisplayName`) makes the two sibling
catalog names differ from our side whenever the raw name doesn't already
say so for that particular type — movies/films/tv/series/show/shows are all
recognized, case-insensitively, as whole words. A name that already
mentions the right type for a given side is left untouched; only the side
that doesn't get our own "· Movies" / "· Series" marker. Since the two
sibling names are then never identical, there's nothing left for Stremio's
own auto-suffix to disambiguate.

## Notes on TMDB reliability & Home-screen load times

Every catalog item requires a second lookup against TMDB (PMDB only
returns IDs). Under a large combined library, this creates two related but
distinct problems, both addressed in `src/tmdb.js`:

**Items silently vanishing / only the first one showing up** — Stremio
requesting a list's movie and series catalogs together, plus other
catalogs loading at the same time, could burst TMDB with no shared
throttle, get rate-limited, and drop whichever items failed with no retry.
Fixed with a single global pace limiter shared by every caller in the
process, plus retry-with-backoff (honoring `Retry-After`) for genuinely
transient failures.

**A specific catalog just doesn't load on Home, but works fine from
Discover** — with several hundred items across all your lists, Stremio's
Home screen fires every catalog's request at once; the pacer above
(correctly) serializes all of that TMDB work, so the *last* catalog's
request can end up waiting long enough to exceed however long Stremio's
Home screen is willing to wait, and that catalog comes back completely
empty. Discover isn't competing with anything else, so it succeeds even
mid-cold-cache. Fixed with a 6-second deadline on catalog-level enrichment
(`getMetaBatch`'s `deadlineMs` option): once time's up, no *new* TMDB
fetch is started (already-cached items are still returned instantly,
since cache hits never touch the pacer), and the request returns whatever
finished in time rather than making the whole thing wait — a prompt
partial catalog beats a full timeout. Combined with the 7-day disk-backed
cache, repeated loads (or just reopening Stremio) converge on a fully
populated catalog as more of it gets cached.

If you maintain a very large combined library (many hundreds of items),
opening the configure page's Lists tab occasionally helps — it prefetches
every list in the background and shares the same cache Stremio's requests
use, so by the time you open Stremio, more of it is already warm.

## Notes on later lists never loading on Home (while Discover works)

If specific catalogs consistently show permanent skeleton loaders on
Stremio's Home screen — especially if *which* ones fail depends on their
position among your configured lists rather than their size — this is
almost certainly Stremio itself capping how many concurrent (or even
queued) requests it will send to one addon. With several configured lists
(each normally becoming up to two catalogs), later requests can sit queued
client-side waiting for a slot; if our earlier responses are slow, Stremio
gives up waiting for those queued rows before they're ever even sent. A
telling symptom: installing a second copy of the same addon lets the
previously-stuck lists load, because that copy gets its own separate
concurrency budget from Stremio's perspective.

Three changes address this from the server side, in `src/addon.js` and
`src/tmdb.js`:

- **Manifest generation is now content-aware.** Previously every
  configured list always became two catalogs (movie + series), even if the
  list only ever contained one type — an always-empty catalog isn't just
  wasted UI, it's a wasted request slot that a real catalog further down
  the list needed. The manifest now only advertises the catalog types a
  list actually contains (checked via a lightweight parallel PMDB fetch,
  independent of TMDB). If that check itself fails, it fails open
  (advertises both) rather than making a list vanish over a transient
  blip.
- **Shorter per-catalog deadline** (6s → 3s) and a **lower per-catalog item
  cap** (150 → 80), so earlier-dispatched catalogs free up a connection
  slot faster, giving later ones a better chance of being sent while
  Stremio is still willing to wait for them.
- **Higher TMDB pacer throughput** (~40 → ~65 req/s app-wide), since the
  existing retry-with-backoff already absorbs occasional 429s from going
  a bit faster.

If you maintain a very large combined library, the single most effective
workaround remains: open the configure page's **Lists** tab before
opening Stremio. It prefetches every list in the background and shares
the exact same in-memory TMDB cache Stremio's own catalog requests use —
so by the time Stremio asks, most of it is already a cache hit (instant,
no pacer or deadline involved at all).

## Notes on connection failures (`ETIMEDOUT`, "Empty Content" that fixes itself)

If the server log shows a `TypeError: fetch failed` with an `ETIMEDOUT`
cause, that's a connection-level timeout — the outbound request to PMDB or
TMDB couldn't even establish a TCP connection in time. This is **not**
rate-limiting (which shows up as an HTTP 429 response, never gets logged
this way, and is already handled with retry — see below); it's a network
reachability blip between your machine and the remote host.

`pmdb.js` previously had no timeout or retry at all, so a single flaky
connection attempt could hang on the OS's own default TCP timeout (which
is where a multi-second `ETIMEDOUT` actually comes from) and then fail the
entire catalog request outright — which is exactly what shows up in
Stremio as "Empty Content" until you try again a minute later and the
blip has passed. It now uses the same resilience pattern as `tmdb.js`: an
8-second request timeout and up to 2 retries with backoff, so a brief
network hiccup self-heals within the request instead of failing it. A
genuinely persistent outage (not just a blip) will still fail after
exhausting retries — bounded, rather than hanging indefinitely.

Seeing the *same* error printed twice in the log for one failure is
expected, not a separate bug: Stremio's movie and series catalog requests
for the same list share one in-flight PMDB fetch (`src/lists.js`'s request
coalescing), so if that shared fetch fails, both callers independently log
it.

## Notes on the reorder UI

Catalog reordering uses hand-rolled Pointer Events (`pointerdown` /
`pointermove` / `pointerup`), not the native HTML5 Drag and Drop API,
which has known reliability problems on Linux (both Firefox and
Chromium-based browsers, particularly under Wayland). The ▲▼ buttons
remain as a fully independent fallback.

## Icon & versioning

The addon manifest now includes a logo (`public/icon.png`) — a sync symbol
in the same amber/charcoal palette as the configure page, since "sync" is
the whole point of the addon. Stremio fetches it from
`http://<host>/icon.png`, so it's served like any other static file in
`public/`; swap that file for your own art if you want to change it (any
reasonably square image works — Stremio scales it).

`ADDON_VERSION` in `src/addon.js` is currently `1.2.0`, reflecting the
dashboard/import-export overhaul (1.1.0) and this round of reliability and
content-aware-manifest fixes (1.2.0) since the original `1.0.0`. Bump it
whenever you want Stremio to recognize a meaningfully new build — it
doesn't update automatically.

## Project structure

```
server.js               Express app: Stremio protocol routes, configure page, preview/build-config API
src/pmdb.js               PublicMetaDB API client
src/tmdb.js                 TMDB client — cache (7-day TTL, disk-persisted), global pacer, retry, deadline-bounded batch enrichment
src/lists.js                  Shared raw-item fetching with request coalescing (used by both the manifest catalogs and the Lists tab preview)
src/config.js                  Encodes/decodes the per-user config (incl. catalog order) in the install URL
src/addon.js                     Manifest builder (incl. catalog naming logic) + Stremio catalog request handling
public/configure.html              Dashboard UI — connect, browse lists, choose & reorder catalogs, import/export keys+lists
public/icon.png                     Addon logo shown in Stremio (sync symbol, amber/charcoal theme)
```
