// Experiment: what does Stremio send when you mark things watched BY HAND?
//
// Off unless the server is started with OBSERVE_LIBRARY=1. When on, it:
//  - declares a `library` resource in each install's manifest, so Stremio sends
//    library events (add/remove, watched/unwatched) to /:config/library/...;
//  - logs every field of every such request (every query key and value, the raw
//    segment, a short hash of the install, the app's User-Agent), answers `{}`;
//  - logs any OTHER request that matches no route (install token masked), so a
//    different path shape shows up instead of silence.
// It writes nothing to PublicMetaDB. Logged: no keys, no tokens.
//
// Already seen: libraryAdd / libraryRemove on a movie, and watched / unwatched
// on a whole season with no episode list. Not yet seen: a single episode, a movie.

const crypto = require('crypto');

const RESOURCE = { name: 'library', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] };
const enabled = () => process.env.OBSERVE_LIBRARY === '1';

function decorateManifest(manifest) {
  if (!enabled() || !manifest) return manifest;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const has = resources.some((r) => (typeof r === 'string' ? r : r && r.name) === 'library');
  if (!has) manifest.resources = [...resources, RESOURCE];
  return manifest;
}

function clean(s, max) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').slice(0, max); }
function who(req) {
  const key = req.pmdbConfig && req.pmdbConfig.pmdbKey;
  return key ? crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 6) : 'unknown';
}
function agent(req) { return clean(typeof req.get === 'function' ? req.get('user-agent') : '', 80); }
function log(msg) { console.log(`[observe] ${new Date().toISOString()} ${msg}`); }

// Every key and value, so nothing Stremio sends can hide from the log.
function describe(extra) {
  const q = new URLSearchParams(String(extra == null ? '' : extra));
  const parts = [];
  for (const [k, v] of q.entries()) {
    const items = v.includes(',') ? ` (${v.split(',').length} ids)` : '';
    parts.push(`${clean(k, 30)}="${clean(v, 200)}"${items}`);
  }
  return parts.length ? parts.join(' ') : '(no parameters)';
}

function handleLibrary(req, res) {
  if (!enabled()) return res.status(404).json({});
  log(`library ${clean(req.params.type, 12)} ${clean(req.params.id, 60)} ${describe(req.params.extra)}` +
    ` raw="${clean(req.params.extra, 400)}" user=${who(req)} ua="${agent(req)}"`);
  return res.json({});
}

// Registered last: sees only requests nothing else answered.
function logUnmatched(req, res, next) {
  if (enabled()) {
    const url = String(req.originalUrl || req.url || '');
    const first = (url.match(/^\/([^/?]+)/) || [])[1] || '';
    const shown = first.length > 40 ? url.replace('/' + first, '/<token>') : url;
    log(`unmatched ${clean(req.method, 8)} ${clean(shown, 200)} ua="${agent(req)}"`);
  }
  next();
}

module.exports = { enabled, decorateManifest, handleLibrary, logUnmatched, describe, RESOURCE };
