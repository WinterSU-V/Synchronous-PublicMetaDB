const pmdb = require('./pmdb');

// Fetches raw (unenriched) items for one of the three kinds of source PMDB
// exposes. Shape of each item: { tmdb_id, media_type, season?, episode? }.
async function fetchRawItems(pmdbKey, source) {
  if (source.kind === 'continue-watching') {
    const data = await pmdb.getResumePoints(pmdbKey, { perPage: 100 });
    return { items: data.items || [], total: data.total ?? (data.items || []).length };
  }

  if (source.kind === 'watchlist') {
    const lists = await pmdb.getLists(pmdbKey, { perPage: 100 });
    const watchlist = (lists.items || []).find((l) => l.type === 'watchlist');
    if (!watchlist) return { items: [], total: 0 };
    const data = await pmdb.getListItems(pmdbKey, watchlist.id, { perPage: 100 });
    return { items: data.items || [], total: data.total ?? (data.items || []).length };
  }

  if (source.kind === 'list' && source.listId) {
    const data = await pmdb.getListItems(pmdbKey, source.listId, { perPage: 100 });
    return { items: data.items || [], total: data.total ?? (data.items || []).length };
  }

  return { items: [], total: 0 };
}

// Short-lived request coalescing + cache. Stremio requests the "movie" and
// "series" catalog variants of the same underlying list back-to-back, and
// the configure page's Lists tab may be prefetching the same list at
// nearly the same time — without this, each of those triggers its own
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

module.exports = { getRawItems, sourceFromCatalogId };
