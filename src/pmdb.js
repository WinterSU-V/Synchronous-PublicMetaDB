const BASE_URL = 'https://publicmetadb.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Without an explicit timeout, a single flaky connection attempt can hang
// on the OS's own (often very long) default TCP timeout before failing —
// that's what an `ETIMEDOUT` after many seconds actually is. Retrying a
// transient network failure or a 5xx/429 a couple of times with backoff
// turns a brief blip into a non-event instead of a full request failure
// (which Stremio sees as "Empty Content").
const MAX_RETRIES = 2; // 3 attempts total
const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        const backoffMs = retryAfterMs || 300 * Math.pow(3, attempt) + Math.random() * 150;
        await sleep(backoffMs);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // A genuine network failure (ETIMEDOUT, ECONNRESET, DNS blip, an
      // aborted request from our own timeout above) — worth retrying.
      if (attempt === MAX_RETRIES) throw e;
      await sleep(300 * Math.pow(3, attempt) + Math.random() * 150);
    }
  }
  throw lastErr;
}

async function pmdbFetch(apiKey, path, params = {}) {
  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  let res;
  try {
    res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  } catch (e) {
    const err = new Error(`PMDB ${path} unreachable: ${e.message}`);
    err.cause = e;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`PMDB ${path} failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// GET /api/external/lists
async function getLists(apiKey, { page = 1, perPage = 50 } = {}) {
  return pmdbFetch(apiKey, '/api/external/lists', { page, perPage });
}

// GET /api/external/lists/:listId/items
async function getListItems(apiKey, listId, { page = 1, perPage = 100 } = {}) {
  return pmdbFetch(apiKey, `/api/external/lists/${listId}/items`, { page, perPage });
}

// GET /api/external/resume
async function getResumePoints(apiKey, { page = 1, perPage = 100 } = {}) {
  return pmdbFetch(apiKey, '/api/external/resume', { page, perPage });
}

module.exports = { getLists, getListItems, getResumePoints };
