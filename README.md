# Synchronous: PublicMetaDB

A Stremio addon that turns your [PublicMetaDB](https://publicmetadb.com)
account — Continue Watching, Watchlist, and any custom lists — into
Stremio catalogs, in whatever order you choose.

## Setup

1. Open the addon's **`/configure`** page (e.g.
   `https://your-deployment-url/configure`).
2. Enter your PMDB API key (Settings → API on publicmetadb.com) and your
   TMDB API key (themoviedb.org → Settings → API), or import a
   previously-exported `.pmdbkeys` file. Click **Load my lists**.
3. **Lists** tab — browse what's in each list. **Configuration** tab —
   tick which lists become Stremio catalogs, and drag ⠿ (or use ▲▼) to
   set their order.
4. Click **Generate install link**, then either tap **Install in
   Stremio**, or copy the manifest URL and paste it into Stremio →
   Addons → search bar.

## Exporting / importing your setup

The ⚙ menu (top right, once you're set up) lets you export your keys —
optionally with your list selection and order — as an encrypted file, so
you can move your setup to another device. It's encrypted with a
passphrase you choose; there's no recovery if you forget it. Keep the
file, and any generated install link, private — both are equivalent to
sharing your API keys.

## Running it yourself

```bash
npm install
npm start
```

Starts the server at `http://127.0.0.1:7000`. See `DEVELOPMENT.md` for
deployment options, architecture notes, and everything else relevant to
maintaining or modifying this addon rather than just using it.
