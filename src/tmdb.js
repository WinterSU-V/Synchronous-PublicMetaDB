const fs = require('fs');
const path = require('path');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';

// In-memory cache: tmdb_id + media_type -> { data, expires }. Title/poster/
// IMDb id essentially never change once set, so a long TTL is safe — and
// more importantly, a cache hit skips the network (and the pacer/deadline
// machinery below) entirely. That machinery only matters on a cold cache.
const cache = new Map();
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Disk persistence ----------------------------------------------------
// Without this, every server restart throws the whole cache away, forcing
// a large library to cold-start again — exactly the condition that makes
// Stremio's Home screen time out on slower catalogs. Best-effort: any
// failure here is swallowed, since this is a pure optimization and never
// load-bearing for correctness.
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'tmdb-cache.json');

function loadCacheFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const now = Date.now();
    for (const [key, value] of entries) {
      if (value && value.expires > now) cache.set(key, value);
    }
  } catch (e) {
    // No file yet, or unreadable/corrupt — start with an empty cache.
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const now = Date.now();
      const entries = [...cache.entries()].filter(([, v]) => v.expires > now);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(entries));
    } catch (e) {
      // Best-effort — in-memory cache still works even if the disk write fails.
    }
  }, 3000);
}

loadCacheFromDisk();

function cacheKey(tmdbId, mediaType) {
  return `${mediaType}:${tmdbId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Global pacing ---------------------------------------------------------
// Shared by every caller in the process — Stremio's separate movie/series
// catalog requests, the configure page's Lists-tab prefetch, etc. — so
// concurrent callers can't stack into a burst that trips TMDB's rate
// limiting.
//
// paceSlot() takes an optional deadline: if the next available slot would
// land after the deadline, it does NOT consume that slot or wait — it just
// reports failure immediately, so a caller that's out of time gives up
// right away instead of sleeping past its own deadline and running long
// regardless. This has to live here (not just as a check before grabbing
// work) because a slot can be assigned far in the future under heavy
// contention; checking only "did I have time when I started" isn't enough
// — the wait itself is what blows the deadline.
const MIN_INTERVAL_MS = 15; // ~65 TMDB req/s app-wide
let nextSlot = 0;

async function paceSlot(deadlineAt) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  if (deadlineAt && slot > deadlineAt) return false; // don't consume the slot, don't wait
  nextSlot = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
  return true;
}

// --- Resilient fetch ---------------------------------------------------
const MAX_RETRIES = 2; // 3 attempts total
const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithRetry(url, deadlineAt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (deadlineAt && Date.now() > deadlineAt) {
      throw new Error('deadline exceeded');
    }
    const gotSlot = await paceSlot(deadlineAt);
    if (!gotSlot) throw new Error('deadline exceeded');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        const backoffMs = retryAfterMs || 250 * Math.pow(3, attempt) + Math.random() * 150;
        await sleep(backoffMs);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === MAX_RETRIES) throw e;
      await sleep(250 * Math.pow(3, attempt) + Math.random() * 150);
    }
  }
  throw lastErr;
}

async function fetchFromTmdb(tmdbId, mediaType, tmdbKey, deadlineAt) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE}/${kind}/${tmdbId}?api_key=${tmdbKey}&append_to_response=external_ids`;
  const res = await fetchWithRetry(url, deadlineAt);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`TMDB ${kind}/${tmdbId} failed: ${res.status}`);
  }
  const data = await res.json();

  const imdbId =
    data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;

  return {
    tmdbId,
    mediaType: kind,
    title: kind === 'tv' ? data.name : data.title,
    poster: data.poster_path ? IMG_BASE + data.poster_path : null,
    imdbId,
    releaseDate: kind === 'tv' ? data.first_air_date : data.release_date
  };
}

// Cache hits are always served regardless of deadline — they never touch
// the network or the pacer, so there's no reason to withhold one just
// because time is short.
async function getMeta(tmdbId, mediaType, tmdbKey, deadlineAt) {
  const key = cacheKey(tmdbId, mediaType);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  if (deadlineAt && Date.now() > deadlineAt) return null;

  const data = await fetchFromTmdb(tmdbId, mediaType, tmdbKey, deadlineAt);
  if (data) {
    cache.set(key, { data, expires: Date.now() + TTL_MS });
    scheduleSave();
  }
  return data;
}

// Enrich many items in parallel. `deadlineMs` bounds the *total* time this
// call will spend — past the deadline, no new network fetch is started
// (already-cached items are still served instantly), and whatever hasn't
// resolved yet comes back as null rather than making the whole call (and
// the Stremio catalog response riding on it) run long. With enough total
// items in flight across every simultaneously-requested catalog, waiting
// for every single one to finish can take longer than Stremio's Home
// screen is willing to wait — and the *entire* catalog would come back
// empty rather than mostly-populated. A prompt partial result is strictly
// better than a full timeout.
async function getMetaBatch(items, tmdbKey, options = {}) {
  const isLegacyNumber = typeof options === 'number';
  const concurrency = isLegacyNumber ? options : (options.concurrency || 5);
  const deadlineMs = isLegacyNumber ? Infinity : (options.deadlineMs ?? Infinity);

  const results = new Array(items.length).fill(null);
  let idx = 0;
  const deadlineAt = deadlineMs === Infinity ? null : Date.now() + deadlineMs;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const { tmdbId, mediaType } = items[i];
      try {
        results[i] = await getMeta(tmdbId, mediaType, tmdbKey, deadlineAt);
      } catch (e) {
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { getMeta, getMetaBatch };
