#!/usr/bin/env node
// Compares what the addon can read from each of your PMDB lists with PMDB's own totals.
//   PMDB_KEY=pm-... node scripts/list-report.js
// Prints, per list: PMDB's total, how many items the addon actually reads, and the mix of
// media types (anything that isn't "movie" or "tv" is shown separately, as is a missing tmdb_id).
// The key is read from the environment only and is never printed.

const lists = require('../src/lists');

(async () => {
  const key = process.env.PMDB_KEY;
  if (!key) { console.error('Set PMDB_KEY first, e.g.  PMDB_KEY=pm-... node scripts/list-report.js'); process.exit(2); }

  const all = await lists.getAllLists(key);
  const rows = [
    { name: 'Continue Watching (resume points)', source: { kind: 'continue-watching' } },
    ...all.items.map((l) => ({
      name: l.name + (l.type && l.type !== 'custom' ? ` [${l.type}]` : ''),
      source: l.type === 'watchlist' ? { kind: 'watchlist' } : { kind: 'list', listId: l.id }
    }))
  ];

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${pad('LIST', 38)} ${pad('PMDB', 6)} ${pad('READ', 6)} ${pad('MOVIE', 6)} ${pad('TV', 6)} OTHER / NO TMDB ID`);
  let problems = 0;
  for (const r of rows) {
    try {
      const { items, total } = await lists.getRawItems(key, r.source);
      const movie = items.filter((i) => i.media_type === 'movie').length;
      const tv = items.filter((i) => i.media_type === 'tv').length;
      const other = items.filter((i) => i.media_type !== 'movie' && i.media_type !== 'tv').length;
      const noId = items.filter((i) => i.tmdb_id == null).length;
      const flag = items.length !== total || other || noId ? '   <-- check' : '';
      if (flag) problems++;
      console.log(`${pad(r.name, 38)} ${pad(total, 6)} ${pad(items.length, 6)} ${pad(movie, 6)} ${pad(tv, 6)} ${other} / ${noId}${flag}`);
    } catch (e) {
      problems++;
      console.log(`${pad(r.name, 38)} failed: ${String(e.message).replace(key, '***').slice(0, 80)}`);
    }
  }
  console.log(problems ? `\n${problems} row(s) flagged.` : '\nEvery list was read in full.');
})();
