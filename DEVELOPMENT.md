# Development notes

Everything here is for maintaining or deploying this addon, not for
using it — see `README.md` for that.

## Project structure

server.js Express app: Stremio protocol routes, configure page, preview/build-config API
src/pmdb.js PublicMetaDB API client (timeout + retry-with-backoff)
src/tmdb.js TMDB client — cache (7-day TTL, disk-persisted), global pacer, retry, deadline-bounded batch enrichment
src/lists.js Shared raw-item fetching with request coalescing
src/config.js Encodes/decodes the per-user config (incl. catalog order) in the install URL
src/addon.js Manifest builder (base + per-config, catalog naming logic) + Stremio catalog request handling
public/configure.html Dashboard UI — connect, browse lists, choose & reorder catalogs, import/export keys+lists
public/icon.png Addon logo (sync symbol, amber/charcoal theme)

## Architecture notes

- PMDB's list/resume endpoints only return `tmdb_id` + `media_type` — no
  poster, title, or IMDb ID. Every item requires a second lookup against
  TMDB. `src/tmdb.js` handles this with a 7-day disk-persisted cache, a
  global pace limiter (~65 req/s app-wide, shared by every caller in the
  process), and retry-with-backoff for transient 429/5xx failures.
- Manifest generation (`buildManifest` in `src/addon.js`) is
  content-aware: it only advertises a movie/series catalog for a list if
  the list actually contains that type, checked via a parallel PMDB fetch
  independent of TMDB. This matters because Stremio caps how many
  concurrent/queued requests it sends to one addon when populating Home —
  an always-empty catalog is a wasted request slot. If the check itself
  fails, it fails open (advertises both types) rather than hiding the
  list.
- Catalog naming (`catalogDisplayName`) avoids duplicate type tags:
  Stremio's Home screen appears to auto-disambiguate two catalogs from
  the same addon when they'd display with an identical name, by
  appending "- Series"/"- Movies" itself. Since a list's movie and series
  catalogs used to always share the same raw name, a list already named
  with a type word (e.g. "Watching - Series") got Stremio's auto-suffix
  stacked on top of it. The fix makes the two sibling names differ from
  our side whenever the raw name doesn't already say so for that
  particular type, removing the naming collision.
- `getCatalog` bounds worst-case latency per Stremio request: a 3-second
  deadline on TMDB enrichment (`CATALOG_DEADLINE_MS`) and an 80-item cap
  per catalog (`MAX_CATALOG_ITEMS`). Past the deadline, no new TMDB fetch
  starts (cache hits are unaffected, since they never touch the pacer),
  and whatever's ready is returned rather than making the whole request
  run long. This exists because Stremio's Home screen fires every
  configured catalog's request at once; if earlier ones are slow, later
  ones can sit queued client-side and never get a chance before Stremio
  gives up waiting for that row.
- `/manifest.json` (no config token) serves a minimal base manifest with
  `catalogs: []` and `behaviorHints.configurationRequired: true` — the
  standard Stremio SDK pattern for configurable addons, and required by
  some deploy validators (Beamup's lint check rejects addons without a
  valid response at this fixed path). The real, per-user manifest is at
  `/:config/manifest.json`.
- `app.set('trust proxy', true)` in `server.js` matters once deployed
  behind a reverse proxy (Beamup, most PaaS hosts): without it,
  `req.protocol` reports the *internal* connection's protocol (`http`)
  rather than what the public-facing request actually used (`https`),
  which silently breaks the absolute icon URL built into the manifest.
- Catalog reordering (`public/configure.html`) uses hand-rolled Pointer
  Events (`pointerdown`/`pointermove`/`pointerup`), not the native HTML5
  Drag and Drop API, which has known reliability problems on Linux (both
  Firefox and Chromium-based browsers, particularly under Wayland). The
  ▲▼ buttons are an independent fallback.
- Export/import (keys, optionally with list selection/order) uses
  AES-256-GCM via the Web Crypto API, with a key derived from a
  user-chosen passphrase via PBKDF2 (210,000 iterations, SHA-256) —
  entirely client-side; nothing touches the server as part of
  export/import. The file is a JSON document with a `.pmdbkeys`
  extension — a custom container, not a proprietary format.

## Deployment

### Beamup (tried and working)

Free, run by Stremio's own team, purpose-built for Stremio addons.
Deploy with `npm install -g beamup-cli`, then `beamup config` followed by
`beamup` from the project directory (or `git push beamup master` for
updates after the first deploy). Needs `PORT` read from the environment
(already handled) and either a Heroku buildpack or Dockerfile — a plain
`package.json` is enough for Node. Runs on a Docker Swarm cluster rather
than a serverless/scale-to-zero model, which is why it stays warm instead
of sleeping after inactivity like Render's free tier.

Known gotchas we hit getting this working:
- The `beamup` project name becomes part of the URL slug — letters,
  numbers, and hyphens only. A name like `Synchronous: PublicMetaDB` (colon,
  space) gets rejected; use something like `synchronous-publicmetadb` or
  accept the default.
- Beamup's `beamup-lint` validator requires a response at the bare
  `/manifest.json` path — see the base-manifest note above.
- Not confirmed either way: whether the on-disk TMDB cache
  (`.cache/tmdb-cache.json`) survives a redeploy, or how Beamup's
  addon-specific edge caching interacts with this app's per-user dynamic
  catalog responses. Worth testing if catalog staleness ever seems off.

Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/deploying/beamup.md
and https://github.com/Stremio/stremio-beamup (the actual infra Stremio
runs — Cherryservers VPS + Docker Swarm + Terraform/Ansible, fronted by
Cloudflare).

### Other options, if Beamup doesn't work out

- **Render's free web service** — easiest to wire up (GitHub integration,
  auto-deploy on push), but free instances spin down after inactivity
  with a 30-60s cold start on the next request. Since Stremio itself
  times out slow catalog responses, this risks the exact "doesn't load,
  works on retry" symptom this addon was tuned to avoid. Free tier disk
  is also ephemeral.
- **Fly.io** — paid now (no true always-free tier), but cheap: ~$2.02/mo
  for an always-running 256MB Machine, ~$3.32/mo for 512MB, per their own
  pricing docs. Persistent volumes (for the TMDB cache) are $0.15/GB/mo.
  Deploy via `flyctl` from a Dockerfile — closer to Render's convenience
  than a bare VPS.
- **A cheap always-on VPS** (Scaleway's Stardust tier ~€1.80-2/mo,
  Cloudzy ~$2.48-3.48/mo) — full root, always-on, real persistent disk,
  sidesteps cold-start risk entirely, but no git-push-to-deploy; you run
  `npm start` yourself (systemd service, or inside `screen`/`tmux`).
- **Avoid Vercel for this app specifically** — not just cold-start-prone
  like Render, but an architecture mismatch: it runs stateless serverless
  functions with no guaranteed memory sharing between invocations, and
  this app depends on shared in-process state (the TMDB pacer, the
  request-coalescing cache, the disk-persisted cache). Concurrent
  requests could land on separate isolated instances that don't share any
  of that, silently reintroducing the rate-limiting bug already fixed.
  Workable in principle by moving that state to something like Redis, but
  that's a real rework, not a deploy setting.

Whichever you use, double-check current pricing/terms yourself — this
space shifts often enough that anything written here can go stale within
the same year.

## Git / GitHub troubleshooting notes

- **`failed to push some refs`**: almost always means the GitHub repo
  wasn't empty (commonly because its creation wizard auto-added a
  README/license/.gitignore). Fix with `git push -u origin main --force`
  if nothing on GitHub is worth keeping, or `git pull origin main
  --allow-unrelated-histories` to merge instead.
- **`Password authentication is not supported for Git operations`**:
  GitHub removed password auth for git over HTTPS in 2021. The password
  prompt needs a Personal Access Token (classic, `repo` scope) instead —
  or switch to SSH entirely (`ssh-keygen -t ed25519`, add the `.pub` key
  to GitHub → Settings → SSH and GPG keys, then `git remote set-url
  origin git@github.com:<user>/<repo>.git`).
- **`Permission ... denied` / 403 on push, even with a token**: the token
  itself lacks write access — check it has the `repo` scope (classic
  tokens) or explicit write permission + repo selection (fine-grained
  tokens). A fresh classic token with `repo` checked is the simplest fix.
- **Mismatched fetch/push URLs** (`git remote -v` shows two different
  URLs, e.g. differing only in case): happens if `git remote set-url` and
  `git remote set-url --push` drift independently. Fix by resetting both
  at once: `git remote set-url origin <url>`.

## Versioning

`ADDON_VERSION` in `src/addon.js` is a manual field — Stremio doesn't
auto-detect new builds, so bump it when you want existing installs to
notice a meaningfully new version.
