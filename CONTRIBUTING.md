# Contributing

This started as a personal project, but PRs and issues are welcome.

## Local setup

```bash
npm install
npm start
```

See `DEVELOPMENT.md` for architecture notes before changing anything in
`src/tmdb.js` or `src/addon.js` specifically — several things in there
(the request pacing, the retry/backoff, the manifest content-type
detection, the catalog-naming logic) exist because of specific bugs found
against real Stremio behavior, not just style choices. The reasoning for
each is documented inline and in `DEVELOPMENT.md`; worth reading before
changing the behavior.

## Reporting a bug

Open an issue with what you were doing, what happened, and — if it's a
Stremio-visible issue — a screenshot of Stremio's actual behavior tends
to be more useful than a description, since a lot of the trickiest bugs
here turned out to be about exactly what Stremio's client does, not our
own code.
