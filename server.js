const express = require('express');
const cors = require('cors');
const path = require('path');

const { encodeConfig, decodeConfig } = require('./src/config');
const { buildManifest, buildBaseManifest, getCatalog } = require('./src/addon');
const pmdb = require('./src/pmdb');
const lists = require('./src/lists');
const tmdb = require('./src/tmdb');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 7000;

// ---- Configure page -------------------------------------------------

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Proxies the "list your lists" call server-side so the browser doesn't
// need PMDB to allow cross-origin requests, and keys never touch a
// database — they only flow through this request into the config string
// (or into a client-side-encrypted export file).
app.post('/api/my-lists', async (req, res) => {
  const { pmdbKey } = req.body || {};
  if (!pmdbKey) return res.status(400).json({ error: 'pmdbKey required' });

  try {
    const data = await pmdb.getLists(pmdbKey, { perPage: 100 });
    res.json({ lists: data.items || [] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Powers the "Lists" tab: a handful of enriched items (poster + title) for
// one source, either for the collapsed card preview or the expanded view.
app.post('/api/preview', async (req, res) => {
  const { pmdbKey, tmdbKey, sourceId, limit } = req.body || {};
  if (!pmdbKey || !tmdbKey || !sourceId) {
    return res.status(400).json({ error: 'pmdbKey, tmdbKey, and sourceId are required' });
  }

  const source = lists.sourceFromCatalogId(sourceId);
  if (!source) return res.status(400).json({ error: 'Unrecognized sourceId' });

  try {
    const { items: rawItems, total } = await lists.getRawItems(pmdbKey, source);
    const effectiveLimit = typeof limit === 'number' ? Math.min(limit, 100) : 100;
    const capped = rawItems.slice(0, effectiveLimit);

    const metas = await tmdb.getMetaBatch(
      capped.map((i) => ({ tmdbId: i.tmdb_id, mediaType: i.media_type })),
      tmdbKey
    );

    const items = metas
      .filter(Boolean)
      .filter((m) => m.poster)
      .map((m) => ({
        title: m.title || 'Unknown',
        poster: m.poster,
        mediaType: m.mediaType
      }));

    res.json({ items, total });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/build-config', (req, res) => {
  const { pmdbKey, tmdbKey, catalogs } = req.body || {};
  if (!pmdbKey || !tmdbKey || !Array.isArray(catalogs)) {
    return res.status(400).json({ error: 'pmdbKey, tmdbKey, and catalogs are required' });
  }
  const config = encodeConfig({ pmdbKey, tmdbKey, catalogs });
  res.json({ config });
});

// ---- Stremio addon protocol ------------------------------------------

function requireConfig(req, res, next) {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ err: 'Invalid or missing configuration' });
  req.pmdbConfig = config;
  next();
}

app.get('/manifest.json', async (req, res) => {
  try {
    res.json(buildBaseManifest());
  } catch (e) {
    console.error(e);
    res.status(500).json({ err: 'Failed to build manifest' });
  }
});

app.get('/:config/manifest.json', requireConfig, async (req, res) => {
  try {
    const manifest = await buildManifest(req.pmdbConfig);
    res.json(manifest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ err: 'Failed to build manifest' });
  }
});

app.get('/:config/catalog/:type/:id.json', requireConfig, async (req, res) => {
  try {
    const result = await getCatalog(req.pmdbConfig, req.params.id);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ metas: [] });
  }
});

app.listen(PORT, () => {
  console.log(`PublicMetaDB Stremio addon running at http://127.0.0.1:${PORT}`);
  console.log(`Open http://127.0.0.1:${PORT}/configure to set it up`);
});
