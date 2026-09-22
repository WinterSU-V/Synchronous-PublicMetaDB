# Synchronous: PublicMetaDB

A Stremio addon that turns your [PublicMetaDB](https://publicmetadb.com)
account — Continue Watching, Watchlist, and any custom lists — into
Stremio catalogs, in whatever order you choose.

## What you'll need

- A [PublicMetaDB](https://publicmetadb.com) account and API key
  (Settings → API).
- A [TMDB](https://themoviedb.org) API key (Settings → API). PMDB only
  returns IDs, not titles or posters — TMDB fills those in.
- Somewhere for the addon itself to run (see below).

## 1. Get it running

You have two options, depending on whether you're the only person using
it and only from this machine, or you want it reachable from Stremio on
other devices too.

### Option A — locally, for personal use only

```bash
npm install
npm start
```

This starts the server at `http://127.0.0.1:7000`. Fine as long as
Stremio is running on the same machine — Stremio on your phone won't be
able to reach `127.0.0.1` on your computer.

### Option B — deployed, so it's reachable from anywhere

The version running in production for this project is hosted on
**[Beamup](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/deploying/beamup.md)**,
a free hosting platform Stremio's own team runs specifically for Stremio
addons:

```bash
npm install -g beamup-cli
beamup config    # one-time: sets your Beamup host + GitHub username
beamup           # deploys from the current directory
```

It'll ask for a project name — letters, numbers, and hyphens only (this
becomes part of your URL) — and prints your live URL when done, something
like `https://<hash>-your-project-name.baby-beamup.club`.

Other hosting options (Fly.io, a cheap VPS, and why Vercel specifically
doesn't fit this app well) are covered in `DEVELOPMENT.md`, along with
every gotcha we ran into getting Beamup working — worth a read if Beamup
ever gives you trouble, since several of its quirks aren't obvious from
its own docs.

## 2. Set up the addon

Open **`/configure`** on wherever it's running — e.g.
`https://your-deployment-url/configure`, or `http://127.0.0.1:7000/configure`
if running locally.

1. Enter your PMDB and TMDB API keys (or import a previously-exported
   `.pmdbkeys` file — see below), then click **Load my lists**.
2. **Lists** tab — browse what's actually in each of your PMDB lists.
3. **Configuration** tab — tick which lists become Stremio catalogs, and
   drag the ⠿ handle (or use the ▲▼ buttons) to set the order Stremio
   will display them in.
4. Click **Generate install link**.

## 3. Install it in Stremio

Either tap **Install in Stremio** (works if you're on the same device as
Stremio), or copy the manifest URL shown and paste it into Stremio →
Addons → search bar.

## Exporting / importing your setup

The **⚙ menu** (top right, once you're set up) lets you export your
keys — optionally along with your list selection and order — as an
encrypted file, so you can move your whole setup to another device in one
step rather than re-entering everything.

It's encrypted client-side with a passphrase you choose (AES-256-GCM via
the browser's Web Crypto API) — nothing is sent to the server as part of
export or import. There's no recovery if you forget the passphrase.

Treat the exported file, and any generated install link, like a
password — both are equivalent to sharing your API keys. Don't post a
manifest URL publicly.

## More

`DEVELOPMENT.md` has architecture notes, the full hosting comparison,
and a running log of git/deployment troubleshooting for anything not
covered here.

## License

MIT — see `LICENSE`.