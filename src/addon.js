const lists = require('./lists');
const tmdb = require('./tmdb');

const ADDON_ID = 'com.publicmetadb.stremio';
const ADDON_VERSION = '1.2.2';

// Every logical catalog (continue-watching / watchlist / list:xxx) becomes
// two Stremio catalogs, one per content type, since a single Stremio
// catalog can't mix movies and series.
function catalogIdFor(baseId, type) {
  return `pmdb-${baseId}-${type}`;
}

// Stremio's Home screen appends its own type label (" – Movie" / " – Series")
// to every catalog row unconditionally — confirmed by testing, not just to
// avoid name collisions as originally assumed. Any suffix added here was
// always redundant on top of that, so names pass through unchanged and
// Stremio handles the disambiguation entirely on its own.
function catalogDisplayName(baseName, type) {
  return baseName;
}

async function buildManifest(config, logoUrl) {
  const catalogs = [];

  // config.catalogs is in the user's chosen display order (set on the
  // configure page via drag/arrow reorder) — preserved as-is here, since
  // Stremio renders catalogs in manifest array order.
  //
  // We only advertise a movie/series catalog for a list if it actually
  // contains that type. Every extra catalog is one more request Stremio
  // has to make when populating Home, and Stremio appears to cap how many
  // concurrent (or even queued) requests it's willing to send to a single
  // addon — an always-empty catalog for a series-only list isn't just
  // wasted UI, it's a wasted request slot that a *real* catalog further
  // down the list might have needed. Fetches run in parallel and are
  // cheap (PMDB only, cached/coalesced by src/lists.js); if one fails, we
  // fail open and advertise both types for that list rather than making a
  // transient blip hide it from Stremio entirely.
  const sourcesWithTypes = await Promise.all(
    config.catalogs.map(async (c) => {
      const source = lists.sourceFromCatalogId(c.id);
      if (!source) return { catalogConfig: c, types: [] };
      try {
        const { items } = await lists.getRawItems(config.pmdbKey, source);
        const types = [];
        if (items.some((i) => i.media_type === 'movie')) types.push('movie');
        if (items.some((i) => i.media_type === 'tv')) types.push('series');
        // Empty list (nothing synced yet) — advertise both so it's not
        // silently invisible; getCatalog will just return no metas.
        return { catalogConfig: c, types: types.length ? types : ['movie', 'series'] };
      } catch (e) {
        return { catalogConfig: c, types: ['movie', 'series'] };
      }
    })
  );

  for (const { catalogConfig: c, types } of sourcesWithTypes) {
    for (const type of types) {
      catalogs.push({
        id: catalogIdFor(c.id, type),
        type,
        name: catalogDisplayName(c.name, type)
      });
    }
  }

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Synchronous: PublicMetaDB',
    description:
      'Continue Watching, Watchlist, and custom lists synced from your PublicMetaDB account.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs,
    ...(logoUrl ? { logo: logoUrl } : {}),
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

// Parses a manifest catalog id like "pmdb-continue-watching-movie" back into
// { catalogConfig, type } by matching against the user's configured
// catalogs, so we know how to fetch the underlying data.
function resolveCatalog(config, requestedId) {
  for (const c of config.catalogs) {
    for (const type of ['movie', 'series']) {
      if (catalogIdFor(c.id, type) === requestedId) {
        return { catalogConfig: c, type };
      }
    }
  }
  return null;
}

function toStremioType(mediaType) {
  return mediaType === 'tv' ? 'series' : 'movie';
}

// Converts enriched TMDB metadata (+ optional season/episode for resume
// items) into a Stremio meta preview object for a catalog response.
function toMetaPreview(meta, extra = {}) {
  if (!meta || !meta.poster) return null; // skip items we can't display well

  const type = toStremioType(meta.mediaType);
  let id = meta.imdbId || `tmdb:${meta.tmdbId}`;

  // Convention used by Trakt/Simkl-style addons: appending season/episode
  // to the id lets Stremio deep-link into that specific episode.
  if (type === 'series' && extra.season != null && extra.episode != null && meta.imdbId) {
    id = `${meta.imdbId}:${extra.season}:${extra.episode}`;
  }

  const preview = {
    id,
    type,
    name: meta.title || 'Unknown',
    poster: meta.poster
  };

  if (extra.description) preview.description = extra.description;
  return preview;
}

// Bounds worst-case latency for a single Stremio catalog request. Stremio
// appears to cap how many concurrent (or even queued) requests it will
// send to one addon at once when populating Home — with several
// configured lists (each becoming 2 catalogs), later ones can sit queued
// client-side waiting for a slot, and if our earlier responses are slow,
// Stremio gives up on those queued rows before they're ever even sent.
// Keeping MAX_CATALOG_ITEMS and CATALOG_DEADLINE_MS both tight is what
// lets earlier catalogs free up a slot quickly enough for later ones to
// get their turn inside Stremio's patience window — not just to bound any
// one catalog's own latency in isolation.
const MAX_CATALOG_ITEMS = 80;
const CATALOG_DEADLINE_MS = 3000;

async function getCatalog(config, requestedId) {
  const resolved = resolveCatalog(config, requestedId);
  if (!resolved) return { metas: [] };

  const { catalogConfig, type } = resolved;
  const mediaTypeFilter = type === 'series' ? 'tv' : 'movie';

  const source = lists.sourceFromCatalogId(catalogConfig.id);
  if (!source) return { metas: [] };

  const { items: allItems } = await lists.getRawItems(config.pmdbKey, source);
  const rawItems = allItems
    .filter((i) => i.media_type === mediaTypeFilter)
    .slice(0, MAX_CATALOG_ITEMS);
  if (rawItems.length === 0) return { metas: [] };

  const metas = await tmdb.getMetaBatch(
    rawItems.map((i) => ({ tmdbId: i.tmdb_id, mediaType: i.media_type })),
    config.tmdbKey,
    { concurrency: 5, deadlineMs: CATALOG_DEADLINE_MS }
  );

  const previews = rawItems
    .map((item, idx) => {
      const extra = {};
      if (item.season != null) extra.season = item.season;
      if (item.episode != null) extra.episode = item.episode;
      return toMetaPreview(metas[idx], extra);
    })
    .filter(Boolean);

  return { metas: previews };
}
// A minimal manifest for the bare /manifest.json URL (no config token).
// Stremio — and validators like Beamup's — expect every addon to answer
// at this fixed path. Since this addon needs per-user keys before it can
// serve real catalogs, this version has none and tells Stremio (via
// configurationRequired) that setup is needed first.
function buildBaseManifest(logoUrl) {
return {
id: ADDON_ID,
version: ADDON_VERSION,
name: 'Synchronous: PublicMetaDB',
description:
'Continue Watching, Watchlist, and custom lists synced from your PublicMetaDB account. Visit /configure to set up.',
resources: ['catalog'],
types: ['movie', 'series'],
catalogs: [],
...(logoUrl ? { logo: logoUrl } : {}),
behaviorHints: {
configurable: true,
configurationRequired: true
}
};
}
module.exports = { buildManifest, buildBaseManifest, getCatalog };
