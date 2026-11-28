const pmdb = require('./pmdb');

// PMDB returns every list newest-first, 100 items per page at most. Earlier
// versions of this file only ever asked for page 1, so a list longer than 100
// items silently lost everything older than its newest 100 - for a mixed
// Watchlist that meant whole types (e.g. all the movies) vanished, and because
// the manifest decides which catalogs to advertise from the same data, the
// missing type's catalog wasn't even offered. Every source is now read to the end.
const PER_PAGE = 100;
const MAX_PAGES = 30;        // safety cap: 3,000 items per source
const PAGE_CONCURRENCY = 3;  // stay gentle on PMDB

function itemKey(item) {
  return item.id != null
    ? String(item.id)
    : `${item.media_type}:${item.tmdb_id}:${item.season ?? ''}:${item.episode ?? ''}`;
}

// Reads every page of a paginated PMDB endpoint. `fetchPage(page)` must return
// { items, total, totalPages }. Order is preserved (page 1 first), duplicates
// that appear when the data shifts mid-read are dropped, and a failure on any
// page fails the whole read rather than returning a silently partial list.
async function fetchAllPages(fetchPage, label = 'list') {
  const first = await fetchPage(1);
  const total = first.total ?? (first.items || []).length;
  let totalPages = first.totalPages || Math.ceil(total / PER_PAGE) || 1;
  if (totalPages > MAX_PAGES) {
    console.warn(`[lists] ${label}: ${totalPages} pages, reading only the first ${MAX_PAGES} (${MAX_PAGES * PER_PAGE} items)`);
    totalPages = MAX_PAGES;
  }

  const pages = [first.items || []];
  const rest = [];
  for (let p = 2; p <= totalPages; p++) rest.push(p);
  const fetched = new Array(rest.length);
  let next = 0;
  async function worker() {
    while (next < rest.length) {
      const i = next++;
      const data = await fetchPage(rest[i]);
      fetched[i] = data.items || [];
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, rest.length) }, worker));
  fetched.forEach((items) => pages.push(items));

  const seen = new Set();
  const items = [];
  for (const page of pages) {
    for (const item of page) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return { items, total };
}

// Every list the account has (the account page can have more than 100).
function getAllLists(pmdbKey) {
  return fetchAllPages((page) => pmdb.getLists(pmdbKey, { page, perPage: PER_PAGE }), 'lists');
}

// Fetches raw (unenriched) items for one of the three kinds of source PMDB
// exposes. Shape of each item: { tmdb_id, media_type, season?, episode? }.
async function fetchRawItems(pmdbKey, source) {
  if (source.kind === 'continue-watching') {
    return fetchAllPages((page) => pmdb.getResumePoints(pmdbKey, { page, perPage: PER_PAGE }), 'continue-watching');
  }

  if (source.kind === 'watchlist') {
    const all = await getAllLists(pmdbKey);
    const watchlist = all.items.find((l) => l.type === 'watchlist');
    if (!watchlist) return { items: [], total: 0 };
    return fetchAllPages((page) => pmdb.getListItems(pmdbKey, watchlist.id, { page, perPage: PER_PAGE }), 'watchlist');
  }

  if (source.kind === 'list' && source.listId) {
    return fetchAllPages((page) => pmdb.getListItems(pmdbKey, source.listId, { page, perPage: PER_PAGE }), `list ${source.listId}`);
  }

  return { items: [], total: 0 };
}

// Short-lived request coalescing + cache. Stremio requests the "movie" and
// "series" catalog variants of the same underlying list back-to-back, and
// the configure page's Lists tab may be prefetching the same list at
// nearly the same time - without this, each of those triggers its own
// separate PMDB round trip for identical data. Concurrent callers within
// the window share one in-flight request; callers shortly after share the
// resolved result.
const rawCache = new Map(); // key -> { promise, expires }
const RAW_TTL_MS = 30 * 1000;

function sourceKey(pmdbKey, source) {
  return `${pmdbKey}:${source.kind}:${source.listId || ''}`;
}

async function getRawItems(pmdbKey, source) {
  const key = sourceKey(pmdbKey, source);
  const cached = rawCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;

  const promise = fetchRawItems(pmdbKey, source).catch((e) => {
    rawCache.delete(key); // never cache a failure
    throw e;
  });
  rawCache.set(key, { promise, expires: Date.now() + RAW_TTL_MS });
  return promise;
}

// Parses the catalog-config `id` field ("continue-watching", "watchlist",
// or "list:<listId>") into a { kind, listId? } source descriptor.
function sourceFromCatalogId(id) {
  if (id === 'continue-watching') return { kind: 'continue-watching' };
  if (id === 'watchlist') return { kind: 'watchlist' };
  if (id.startsWith('list:')) return { kind: 'list', listId: id.slice(5) };
  return null;
}

module.exports = { getRawItems, sourceFromCatalogId, getAllLists, _internal: { fetchAllPages, rawCache, PER_PAGE, MAX_PAGES, PAGE_CONCURRENCY } };
