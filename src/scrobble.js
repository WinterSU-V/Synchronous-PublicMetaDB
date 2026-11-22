// Watch-state sync -> PublicMetaDB.
//
// Two signals, in order of preference:
//
//  1. Player events (recent Stremio builds). An addon that declares a `player`
//     resource is sent  GET /:config/player/:type/:id/action=start|pause|stop
//     &currentTime=<ms>&duration=<ms>.json  as you play. Observed behaviour:
//       - `start` fires on first play, on un-pause AND after every seek;
//       - `pause` / `stop` carry the position; there is no heartbeat between;
//       - closing the window mid-playback sends no `stop`;
//       - `duration` at the first `start` can be a metadata estimate.
//     We save progress to PMDB's resume endpoint (pause / stop / a `start` that
//     follows a seek or resume) and mark the title WATCHED when a `pause` or
//     `stop` lands at >= 80% - the same threshold PMDB itself uses. A `start`
//     at >= 80% (dragging the seek bar to the end) never marks anything.
//
//  2. Subtitles requests (any app). Apps ask for subtitles as playback loads,
//     so for apps that send no player events (e.g. Nuvio) a title is marked
//     watched when playback STARTS. This only fires if no player event for the
//     same title arrives within a short grace window - and never at all once
//     this install has been seen sending player events from the same app
//     (matched by User-Agent). Autoplayed next episodes can go a while before
//     their first player event, so the window alone isn't enough.
//
// Per install: both resources are declared only when `scrobble.enabled` is in
// the config token. Only IMDb ("tt...") and TMDB ("tmdb:...") ids are used.
// Everything runs in the background after the app has been answered.
// The server keeps no database: throttles and cooldowns are in-process.
// SCROBBLE_DRY_RUN=1 does the real lookups but writes nothing to PMDB.

const crypto = require('crypto');

const TMDB_FIND = 'https://api.themoviedb.org/3/find';
const PMDB_API = 'https://publicmetadb.com/api/external';
const PMDB_WATCHED = `${PMDB_API}/watched`; // POST ?dedupe=true
const PMDB_RESUME = `${PMDB_API}/resume`;   // POST

const COMPLETE = 0.8;  // same rule as PMDB: >= 80% is completed
const MIN_SAVE = 0.02; // PMDB ignores progress under 2%
const WATCHED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED = 5000;

const settings = {
  graceMs: 15000,       // how long a subtitles request waits for player events
  retryDelayMs: 400,    // base delay between TMDB lookup retries
  throttle: { start: 15000, pause: 5000, stop: 0 } // min gap between progress saves per item
};

const RESOURCES = ['subtitles', 'player'].map((name) => ({
  name, types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:']
}));

const idCache = new Map();    // "movie:tt123" -> { tmdbId, expires }
const recent = new Map();     // watched-mark cooldowns
const lastResume = new Map(); // progress-save throttles
const playerSeen = new Map(); // session key -> last player event time
const tails = new Map();      // per-session work queues
const playerClients = new Map(); // "install|app" -> last player event: apps known to send them
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const enabledFor = (config) => !!(config && config.scrobble && config.scrobble.enabled);
const dryRun = () => process.env.SCROBBLE_DRY_RUN === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s, max) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').slice(0, max); }
function digest(key, n) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, n); }
function log(msg) { console.log(`[scrobble] ${new Date().toISOString()} ${msg}`); }
function setBounded(map, key, value) {
  map.delete(key); map.set(key, value);
  while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}
const sessionKey = (config, type, id) => `${digest(config.pmdbKey, 16)}|${type}|${id}`;
// An "app" is identified by its User-Agent: Stremio sends the same one on its
// player events and its subtitles requests, and Nuvio's differs.
const clientKey = (config, req) =>
  `${digest(config.pmdbKey, 16)}|${digest(typeof req.get === 'function' ? req.get('user-agent') || '' : '', 12)}`;

function decorateManifest(manifest, config) {
  if (!manifest || !enabledFor(config)) return manifest;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const have = new Set(resources.map((r) => (typeof r === 'string' ? r : r && r.name)));
  manifest.resources = [...resources, ...RESOURCES.filter((r) => !have.has(r.name))];
  return manifest;
}

// Stremio video ids: "tt123" (movie), "tt123:1:2" (episode of show tt123),
// plus our own "tmdb:550" / "tmdb:1399:1:2" fallbacks. Returns null if unusable.
function parseVideoId(type, rawId) {
  if (type !== 'movie' && type !== 'series') return null;
  const parts = String(rawId).split(':');
  let imdbId = null; let tmdbId = null; let rest;
  if (parts[0] === 'tmdb') {
    if (!/^\d{1,9}$/.test(parts[1] || '') || Number(parts[1]) <= 0) return null;
    tmdbId = Number(parts[1]); rest = parts.slice(2);
  } else if (/^tt\d{6,10}$/.test(parts[0])) {
    imdbId = parts[0]; rest = parts.slice(1);
  } else {
    return null;
  }
  if (type === 'movie') return rest.length === 0 ? { imdbId, tmdbId } : null;
  if (rest.length !== 2 || !/^\d{1,4}$/.test(rest[0]) || !/^\d{1,5}$/.test(rest[1])) return null;
  const season = Number(rest[0]); const episode = Number(rest[1]);
  if (episode < 1) return null;
  return { imdbId, tmdbId, season, episode };
}

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}

// Retries network errors, timeouts, 429 and 5xx (up to 3 tries). A 4xx such as
// a bad TMDB key fails at once - retrying can't help.
async function resolveTmdb(imdbId, mediaType, tmdbKey) {
  const ck = `${mediaType}:${imdbId}`;
  const hit = idCache.get(ck);
  if (hit && hit.expires > Date.now()) return hit.tmdbId;
  const url = `${TMDB_FIND}/${imdbId}?external_source=imdb_id&api_key=${encodeURIComponent(tmdbKey)}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(settings.retryDelayMs * 3 ** (attempt - 1));
    let res;
    try { res = await fetchWithTimeout(url, {}, 6000); } catch (e) { lastErr = e; continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = new Error(`TMDB lookup failed (status ${res.status})`); continue; }
    if (!res.ok) throw new Error(`TMDB lookup failed (status ${res.status})`);
    const data = await res.json();
    const list = mediaType === 'movie' ? data.movie_results : data.tv_results;
    const id = list && list[0] && list[0].id;
    if (id) idCache.set(ck, { tmdbId: id, expires: Date.now() + MAP_TTL_MS });
    return id || null;
  }
  throw lastErr;
}

// One retry, network errors only. Safe for watched marks because of dedupe=true.
async function pmdbPost(pmdbKey, url, body) {
  const attempt = () => fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pmdbKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  try { return await attempt(); } catch (e) { return await attempt(); }
}

async function identify(config, type, rawId) {
  const parsed = parseVideoId(type, rawId);
  if (!parsed) { log(`skipped ${clean(type, 12)} ${clean(rawId, 60)} (not an IMDb/TMDB id)`); return null; }
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  const tmdbId = parsed.tmdbId || await resolveTmdb(parsed.imdbId, mediaType, config.tmdbKey);
  const label = `${mediaType} ${parsed.imdbId || 'tmdb:' + tmdbId}` + (mediaType === 'tv' ? ` S${parsed.season}E${parsed.episode}` : '');
  if (!tmdbId) { log(`no TMDB match for ${label}`); return null; }
  return { mediaType, tmdbId, season: parsed.season, episode: parsed.episode, label };
}

const bodyFor = (ident) => ({
  tmdb_id: ident.tmdbId, media_type: ident.mediaType,
  ...(ident.mediaType === 'tv' ? { season: ident.season, episode: ident.episode } : {})
});

// dedupe=true: if PMDB already has a matching play it returns that instead of
// logging another, so finishing the same film twice still counts once.
async function markWatched(config, ident, reason) {
  const key = ['w', digest(config.pmdbKey, 16), ident.mediaType, ident.tmdbId, ident.season ?? '', ident.episode ?? ''].join('|');
  const last = recent.get(key);
  if (last && Date.now() - last < WATCHED_COOLDOWN_MS) return false;
  setBounded(recent, key, Date.now()); // before the network call, so concurrent duplicates drop
  const body = bodyFor(ident);
  if (dryRun()) { log(`DRY RUN would mark ${ident.label} watched (${reason}): ${JSON.stringify(body)}`); return true; }
  try {
    const res = await pmdbPost(config.pmdbKey, `${PMDB_WATCHED}?dedupe=true`, body);
    if (res.ok) { log(`marked ${ident.label} watched (${reason}) -> tmdb ${ident.tmdbId} (status ${res.status})`); return true; }
    recent.delete(key);
    let detail = ''; try { detail = clean(await res.text(), 120); } catch (e) { /* ignore */ }
    log(`PMDB refused watched mark for ${ident.label} (status ${res.status}) ${detail}`);
    return false;
  } catch (e) { recent.delete(key); throw e; }
}

async function saveResume(config, ident, posMs, durMs, pct) {
  const body = { ...bodyFor(ident), position_ms: Math.round(posMs), runtime_ms: Math.round(durMs) };
  const shown = `${Math.round(pct * 100)}%`;
  if (dryRun()) { log(`DRY RUN would save progress ${ident.label} at ${shown}: ${JSON.stringify(body)}`); return true; }
  const res = await pmdbPost(config.pmdbKey, PMDB_RESUME, body);
  if (!res.ok) {
    let detail = ''; try { detail = clean(await res.text(), 120); } catch (e) { /* ignore */ }
    log(`PMDB refused progress for ${ident.label} (status ${res.status}) ${detail}`);
    return false;
  }
  let action = '';
  try { const j = await res.json(); if (j && j.action) action = ` (${clean(j.action, 20)})`; } catch (e) { /* ignore */ }
  log(`saved progress ${ident.label} at ${shown}${action}`);
  return true;
}

// Work for one install+title runs in order, so a quick `stop` can't overtake a
// slow `start` that is still looking up the TMDB id.
function enqueue(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  tails.set(key, next);
  const release = () => { if (tails.get(key) === next) tails.delete(key); };
  next.then(release, release);
  return next;
}

async function processPlayer(config, type, rawId, extra) {
  const q = new URLSearchParams(String(extra == null ? '' : extra));
  const action = q.get('action');
  if (action !== 'start' && action !== 'pause' && action !== 'stop') return;
  const pos = Number(q.get('currentTime'));
  const dur = Number(q.get('duration'));
  if (!(dur > 0) || !(pos >= 0)) return log(`ignored ${action} for ${clean(rawId, 60)} (no usable position/duration)`);
  const pct = Math.min(1, pos / dur);

  // Cheap exits before any network call.
  if (pct < MIN_SAVE) return;                       // too early to matter (PMDB ignores it too)
  if (action === 'start' && pct >= COMPLETE) return; // seeked to the end: wait for a real pause/stop
  const completed = pct >= COMPLETE;                 // (only pause/stop get here)

  const tkey = `r|${sessionKey(config, type, rawId)}`;
  const gap = settings.throttle[action];
  const lastSent = lastResume.get(tkey);
  if (gap && lastSent && Date.now() - lastSent < gap) return;
  setBounded(lastResume, tkey, Date.now());

  const ident = await identify(config, type, rawId);
  if (!ident) return;
  if (completed) {
    await markWatched(config, ident, `${action} at ${Math.round(pct * 100)}%`);
    await saveResume(config, ident, pos, dur, pct).catch(() => {}); // lets PMDB clear any older resume point
    return;
  }
  await saveResume(config, ident, pos, dur, pct);
}

// Legacy / fallback: mark watched when playback starts.
async function record(config, type, rawId, reason = 'playback started') {
  const ident = await identify(config, type, rawId);
  if (ident) await markWatched(config, ident, reason);
}

// GET /:config/player/:type/:id/:extra.json (after requireConfig)
function handlePlayer(req, res) {
  res.json({});
  const config = req.pmdbConfig;
  if (!enabledFor(config)) return;
  const { type, id, extra } = req.params;
  const sk = sessionKey(config, type, id);
  setBounded(playerSeen, sk, Date.now()); // synchronously, so a waiting subtitles fallback stands down
  setBounded(playerClients, clientKey(config, req), Date.now());
  enqueue(sk, () => processPlayer(config, type, id, extra)).catch((e) => {
    log(`failed for ${clean(type, 12)} ${clean(id, 60)}: ${clean(e && e.message, 120)}`);
  });
}

// GET /:config/subtitles/:type/:id[/:extra].json (after requireConfig)
function handleSubtitles(req, res) {
  res.json({ subtitles: [] }); // answer first; never hold playback up
  const config = req.pmdbConfig;
  if (!enabledFor(config)) return;
  const { type, id } = req.params;
  const learned = playerClients.get(clientKey(config, req));
  if (learned && Date.now() - learned < CLIENT_TTL_MS) return; // this app sends player events: no start-of-play mark
  const sk = sessionKey(config, type, id);
  const askedAt = Date.now();
  const timer = setTimeout(() => {
    const seen = playerSeen.get(sk);
    if (seen && seen >= askedAt - 5000) return; // player events are tracking this one properly
    record(config, type, id, 'playback started; this app sends no player events').catch((e) => {
      log(`failed for ${clean(type, 12)} ${clean(id, 60)}: ${clean(e && e.message, 120)}`);
    });
  }, settings.graceMs);
  if (timer.unref) timer.unref();
}

module.exports = {
  decorateManifest, handlePlayer, handleSubtitles,
  _internal: {
    parseVideoId, record, processPlayer, enabledFor, settings,
    reset() { [idCache, recent, lastResume, playerSeen, tails, playerClients].forEach((m) => m.clear()); },
    sizes: () => ({ recent: recent.size, lastResume: lastResume.size, playerSeen: playerSeen.size, clients: playerClients.size, ids: idCache.size }),
    async idle() { while (tails.size) await Promise.all([...tails.values()].map((pr) => pr.catch(() => {}))); }
  }
};
