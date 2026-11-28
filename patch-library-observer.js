#!/usr/bin/env node
// Wires in the manual-watched experiment (inert unless OBSERVE_LIBRARY=1). 4 small edits to server.js.
// Run from the project root:  node patch-library-observer.js
// All-or-nothing, syntax-checked, safe to re-run. Review with: git diff
// When the experiment is done, delete src/observe-library.js and its 4 lines in server.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = (...lines) => lines.join('\n');
const FILE = 'server.js';

const edits = [
  { name: 'require the library observer',
    find: "const scrobble = require('./src/scrobble');",
    replace: L("const scrobble = require('./src/scrobble');", "const observeLibrary = require('./src/observe-library');") },
  { name: 'declare the library resource (only when OBSERVE_LIBRARY=1)',
    find: 'scrobble.decorateManifest(manifest, req.pmdbConfig);',
    replace: L('scrobble.decorateManifest(manifest, req.pmdbConfig);', '    observeLibrary.decorateManifest(manifest);') },
  { name: 'library event routes (404 unless OBSERVE_LIBRARY=1)',
    find: "app.get('/:config/player/:type/:id/:extra.json', requireConfig, scrobble.handlePlayer);",
    replace: L(
      "app.get('/:config/player/:type/:id/:extra.json', requireConfig, scrobble.handlePlayer);",
      "app.get('/:config/library/:type/:id/:extra.json', requireConfig, observeLibrary.handleLibrary);",
      "app.get('/:config/library/:type/:id.json', requireConfig, observeLibrary.handleLibrary);") },
  { name: 'log requests nothing else answered (only when OBSERVE_LIBRARY=1)',
    find: 'app.listen(PORT, () => {',
    replace: L(
      '// Experiment (OBSERVE_LIBRARY=1): log requests nothing else answered. Silent otherwise.',
      'app.use(observeLibrary.logUnmatched);', '', 'app.listen(PORT, () => {') }
];

const full = path.join(process.cwd(), FILE);
if (!fs.existsSync(full)) { console.log(`${FILE} not found - run this from the project root.`); process.exit(1); }
const original = fs.readFileSync(full, 'utf8');
let text = original;
const problems = [];
for (const e of edits) {
  if (text.includes(e.replace)) { console.log(`  already applied: ${e.name}`); continue; }   // insertion edits: replacement contains the anchor
  const count = text.split(e.find).length - 1;
  if (count !== 1) { problems.push(`${e.name}: expected the anchor exactly once, found ${count}\n      anchor: ${e.find}`); continue; }
  text = text.replace(e.find, () => e.replace);
  console.log(`  will apply:      ${e.name}`);
}
if (text !== original) { try { new vm.Script(text, { filename: FILE }); } catch (err) { problems.push(`result would not parse (${err.message})`); } }
if (problems.length) {
  console.log('\nCannot patch safely - nothing was changed:'); problems.forEach((p) => console.log('  - ' + p));
  console.log('\nSend me this output and I will adjust the patch to match your file.'); process.exit(1);
}
if (text === original) { console.log('\nNothing to do - already patched.'); process.exit(0); }
fs.writeFileSync(full, text);
console.log(`\nDone - ${FILE} patched. Review with: git diff`);
