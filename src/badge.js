// Poster rating badges.
//
// Stremio's catalog format only takes a plain poster URL per item, so the
// only way to show a badge is to draw it onto the poster ourselves. When a
// user enables badges, their catalog responses point posters at
// /badge/<tmdb-poster-file>?r=7.8&p=tr&s=12&o=90&h=pill on this server,
// which fetches the real poster from TMDB's image CDN, draws the badge, and
// returns the result.
//
// Design choices worth knowing:
//  - Stateless: everything needed to draw is in the URL (poster file name,
//    rating, style), so no API key or cache lookup is needed to serve one,
//    and a changed rating or style naturally produces a new URL.
//  - `sharp` is an *optional* dependency. If it failed to install on the
//    host, isAvailable() is false and catalogs simply keep their normal
//    posters, rather than the whole addon failing.
//  - Any failure while drawing redirects to the original TMDB poster, so
//    the worst case is a poster without a badge, never a broken image.
//  - Digits are drawn as vector paths, not text, so rendering doesn't depend
//    on which fonts the host machine happens to have.

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache({ memory: 64, files: 0, items: 50 });
  sharp.concurrency(1); // be gentle on small shared hosts
} catch (e) {
  sharp = null;
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
// TMDB poster file names look like "kqjL17yufvn9OVLyXYpvtyrFfak.jpg".
// Validating strictly also means this can only ever fetch from TMDB's CDN.
const FILE_RE = /^[A-Za-z0-9_-]{8,80}\.(jpg|jpeg|png)$/;

const POSITIONS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br']; // top/bottom x left/centre/right
const SHAPES = ['pill', 'rounded', 'square', 'circle'];
// Top-right by default: Stremio draws its own "watched" tick at the
// top-left of posters and a progress bar along the bottom of in-progress ones.
const DEFAULTS = { pos: 'tr', size: 12, opacity: 90, shape: 'pill' };

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Always returns a safe, in-range style, whatever it's given. This is what
// keeps arbitrary query strings from producing unbounded image variants.
function normalizeStyle(raw) {
  const r = raw || {};
  return {
    pos: POSITIONS.includes(r.pos) ? r.pos : DEFAULTS.pos,
    size: clampInt(r.size, 8, 24, DEFAULTS.size),
    opacity: clampInt(r.opacity, 30, 100, DEFAULTS.opacity),
    shape: SHAPES.includes(r.shape) ? r.shape : DEFAULTS.shape
  };
}

// ---- Glyphs: stroked paths in a 6 x 10 box ---------------------------------
const GLYPHS = {
  '0': 'M3 .9 C1.5 .9 .9 2.6 .9 5 C.9 7.4 1.5 9.1 3 9.1 C4.5 9.1 5.1 7.4 5.1 5 C5.1 2.6 4.5 .9 3 .9 Z',
  '1': 'M1.2 2.9 L3.5 .9 L3.5 9.1',
  '2': 'M.9 2.9 C.9 1.5 1.7 .9 3 .9 C4.3 .9 5.1 1.6 5.1 2.9 C5.1 4.2 4.3 5 3.3 5.9 L.9 9.1 L5.2 9.1',
  '3': 'M.9 1.9 C1.4 1.2 2.1 .9 3 .9 C4.3 .9 5 1.6 5 2.7 C5 3.9 4.1 4.5 2.6 4.6 C4.3 4.7 5.2 5.4 5.2 6.9 C5.2 8.3 4.3 9.1 3 9.1 C2 9.1 1.2 8.8 .8 8.1',
  '4': 'M4.2 9.1 L4.2 .9 L.8 6.6 L5.4 6.6',
  '5': 'M4.9 .9 L1.5 .9 L1.1 4.7 C1.7 4.3 2.3 4.1 3.1 4.1 C4.5 4.1 5.2 5 5.2 6.6 C5.2 8.1 4.4 9.1 3 9.1 C2 9.1 1.3 8.8 .8 8.1',
  '6': 'M4.7 1.4 C4.2 1 3.7 .9 3.1 .9 C1.6 .9 .9 2.3 .9 5.2 L.9 6.6 C.9 8.2 1.7 9.1 3 9.1 C4.4 9.1 5.1 8.2 5.1 6.7 C5.1 5.2 4.4 4.3 3 4.3 C2 4.3 1.3 4.8 .9 5.6',
  '7': 'M.8 .9 L5.2 .9 L2.4 9.1',
  '8': 'M3 4.7 C1.6 4.7 1 3.9 1 2.8 C1 1.6 1.7 .9 3 .9 C4.3 .9 5 1.6 5 2.8 C5 3.9 4.4 4.7 3 4.7 C1.5 4.7 .8 5.6 .8 6.9 C.8 8.3 1.6 9.1 3 9.1 C4.4 9.1 5.2 8.3 5.2 6.9 C5.2 5.6 4.5 4.7 3 4.7 Z',
  '9': 'M1.3 8.6 C1.8 9 2.3 9.1 2.9 9.1 C4.4 9.1 5.1 7.7 5.1 4.8 L5.1 3.4 C5.1 1.8 4.3 .9 3 .9 C1.6 .9 .9 1.8 .9 3.3 C.9 4.8 1.6 5.7 3 5.7 C4 5.7 4.7 5.2 5.1 4.4'
};
const GLYPH_W = { '.': 2.4 };
const DIGIT_W = 6;
const GLYPH_GAP = 1.7;
const STROKE = 1.7;

function glyphWidth(ch) { return GLYPH_W[ch] || DIGIT_W; }

function textWidth(str) {
  let w = 0;
  for (const ch of str) w += glyphWidth(ch);
  return w + GLYPH_GAP * (str.length - 1);
}

function glyphMarkup(str, x0) {
  let x = x0;
  let out = '';
  for (const ch of str) {
    if (ch === '.') {
      out += `<circle cx="${(x + 1.2).toFixed(2)}" cy="8.6" r="1.05" fill="#f2ede2" stroke="none"/>`;
    } else if (GLYPHS[ch]) {
      out += `<path transform="translate(${x.toFixed(2)} 0)" d="${GLYPHS[ch]}"/>`;
    }
    x += glyphWidth(ch) + GLYPH_GAP;
  }
  return out;
}

function starPoints(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = ((-90 + i * 36) * Math.PI) / 180;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

// Returns the badge as an SVG sized in real pixels for a poster `pw` wide.
function badgeSvg(ratingText, style, pw) {
  const padX = 4.4, padY = 3.5, textH = 10;
  const tw = textWidth(ratingText);
  const star = { w: 10.4, gap: 3 };
  const circle = style.shape === 'circle';

  // "size" is defined by the pill's height; every shape uses the same scale
  // so digits are the same size whichever shape is picked (a circle ends up
  // a little larger than the pill's height, since it has no star beside it).
  const REF_H = textH + padY * 2;
  let W, H;
  if (circle) { H = W = Math.max(tw + 6, REF_H); }
  else { W = padX * 2 + star.w + star.gap + tw; H = REF_H; }

  const rx = style.shape === 'pill' || circle ? H / 2 : style.shape === 'rounded' ? H * 0.28 : 0.6;
  const refPx = Math.max(16, Math.round((pw * style.size) / 100));
  const k = refPx / REF_H;
  const heightPx = Math.round(H * k);
  const widthPx = Math.round(W * k);

  let content;
  if (circle) {
    content = `<g transform="translate(0 ${(H - textH) / 2})" fill="none" stroke="#f2ede2" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${glyphMarkup(ratingText, (W - tw) / 2)}</g>`;
  } else {
    content =
      `<polygon transform="translate(${padX} ${padY})" points="${starPoints(5.2, 5.5, 5.2, 2.3)}" fill="#e8a33d"/>` +
      `<g transform="translate(0 ${padY})" fill="none" stroke="#f2ede2" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${glyphMarkup(ratingText, padX + star.w + star.gap)}</g>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}">` +
    `<g opacity="${(style.opacity / 100).toFixed(2)}">` +
    `<rect x="0.4" y="0.4" width="${(W - 0.8).toFixed(2)}" height="${(H - 0.8).toFixed(2)}" rx="${rx.toFixed(2)}" fill="#14120f" fill-opacity="0.88" stroke="#e8a33d" stroke-opacity="0.65" stroke-width="0.8"/>` +
    content +
    `</g></svg>`;
  return { svg, widthPx, heightPx };
}

// Draws the badge onto a poster image buffer; returns a JPEG buffer.
async function compose(posterBuf, rating, rawStyle) {
  const style = normalizeStyle(rawStyle);
  const { width: pw, height: ph } = await sharp(posterBuf).metadata();
  const ratingText = (Math.round(rating * 10) / 10).toFixed(1);
  const { svg, widthPx, heightPx } = badgeSvg(ratingText, style, pw);

  const m = Math.round(pw * 0.035);
  const horiz = style.pos[1]; // 'l' | 'c' | 'r'
  const left = horiz === 'l' ? m : horiz === 'c' ? Math.max(0, Math.round((pw - widthPx) / 2)) : Math.max(0, pw - widthPx - m);
  const top = style.pos[0] === 't' ? m : Math.max(0, ph - heightPx - m);

  return sharp(posterBuf)
    .composite([{ input: Buffer.from(svg), left, top }])
    .jpeg({ quality: 86 })
    .toBuffer();
}

// ---- Serving -----------------------------------------------------------------
const CACHE_MAX = 400; // composed posters kept in memory (~50-100KB each)
const cache = new Map();
const inflight = new Map();
const MAX_CONCURRENT = 3;
let active = 0;
const waiters = [];

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v); // refresh recency
  return v;
}
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Small semaphore so a screen full of posters can't saturate a tiny host.
async function withSlot(fn) {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise((resolve) => waiters.push(resolve)); // slot handed over
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}

async function fetchPoster(file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${TMDB_IMG}/${file}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`poster fetch ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Validates a /badge query; returns { rating, style } or null.
function parseQuery(q) {
  const rating = parseFloat(q.r);
  if (!(rating > 0 && rating <= 10)) return null;
  return {
    rating: Math.round(rating * 10) / 10,
    style: normalizeStyle({ pos: q.p, size: q.s, opacity: q.o, shape: q.h })
  };
}

function composedPoster(file, parsed) {
  const { rating, style } = parsed;
  const key = `${file}|${rating}|${style.pos}|${style.size}|${style.opacity}|${style.shape}`;
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);

  const job = withSlot(async () => {
    const poster = await fetchPoster(file);
    const out = await compose(poster, rating, style);
    cacheSet(key, out);
    return out;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// Express handler for GET /badge/:file
async function handle(req, res) {
  const file = req.params.file;
  if (!FILE_RE.test(file)) return res.status(400).send('Bad poster file');

  const original = `${TMDB_IMG}/${file}`;
  const parsed = parseQuery(req.query || {});
  if (!sharp || !parsed) return res.redirect(302, original);

  try {
    const buf = await composedPoster(file, parsed);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.send(buf);
  } catch (e) {
    // Worst case is a poster without a badge, never a broken image.
    return res.redirect(302, original);
  }
}

// ---- Config / catalog integration ------------------------------------------
// Cleans badge settings arriving from the configure page before they're
// baked into the install token. Returns null when badges are off.
function sanitizeSettings(raw) {
  if (!raw || !raw.enabled) return null;
  let origin;
  try {
    const u = new URL(String(raw.base));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    origin = u.origin;
  } catch (e) {
    return null;
  }
  return { enabled: true, base: origin, ...normalizeStyle(raw) };
}

// Poster URL for one catalog item, or null when it shouldn't get a badge
// (badges off, no rating yet, no poster).
function posterUrl(cfg, meta) {
  if (!cfg || !cfg.enabled || !meta || !meta.posterPath || !(meta.voteAverage > 0)) return null;
  let origin;
  try { origin = new URL(cfg.base).origin; } catch (e) { return null; }
  const file = String(meta.posterPath).replace(/^\//, '');
  if (!FILE_RE.test(file)) return null;
  const s = normalizeStyle(cfg);
  const r = (Math.round(meta.voteAverage * 10) / 10).toFixed(1);
  return `${origin}/badge/${file}?r=${r}&p=${s.pos}&s=${s.size}&o=${s.opacity}&h=${s.shape}`;
}

// Used by getCatalog: swaps in the badge URL when enabled and possible,
// otherwise returns the preview untouched.
function applyPoster(preview, meta, config) {
  if (!preview || !sharp) return preview;
  const url = posterUrl(config && config.badges, meta);
  if (url) preview.poster = url;
  return preview;
}

module.exports = {
  isAvailable: () => !!sharp,
  handle,
  sanitizeSettings,
  posterUrl,
  applyPoster,
  compose,
  _internal: { normalizeStyle, parseQuery, badgeSvg, FILE_RE }
};
