#!/usr/bin/env node
// Keeps the addon's version number in step across every place it appears:
//   package.json               "version"
//   package-lock.json          "version" and packages[""].version   (if present)
//   src/addon.js               const ADDON_VERSION = '...'          (the manifest version)
//   public/configure.html      <span class="footer-version">v...</span>   (every footer)
//
// Usage (from anywhere inside the project):
//   node scripts/bump-version.js patch        1.3.0 -> 1.3.1
//   node scripts/bump-version.js minor        1.3.1 -> 1.4.0
//   node scripts/bump-version.js major        1.4.0 -> 2.0.0
//   node scripts/bump-version.js 2.5.9        set an exact version
//   node scripts/bump-version.js --check      show every version and flag drift (changes nothing)
//   add --dry-run to any bump to preview it
//
// The base for patch/minor/major is the HIGHEST version found, so it can never
// move a number backwards when the files have drifted apart.
// All-or-nothing: every file is checked first and nothing is written unless all pass.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const P = {
  pkg: path.join(root, 'package.json'),
  lock: path.join(root, 'package-lock.json'),
  addon: path.join(root, 'src', 'addon.js'),
  html: path.join(root, 'public', 'configure.html')
};
const SEMVER = /^\d+\.\d+\.\d+$/;
const ADDON_RE = /(const ADDON_VERSION\s*=\s*)(['"])(\d+\.\d+\.\d+)\2/;
const FOOTER_RE = /(<span class="footer-version">v?)(\d+\.\d+\.\d+)(<\/span>)/g;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const target = args.find((a) => !a.startsWith('--'));
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

function usage() {
  fail('Usage: node scripts/bump-version.js <patch|minor|major|X.Y.Z> [--dry-run]\n       node scripts/bump-version.js --check');
}

// ---- read everything ----------------------------------------------------------
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const text = { pkg: read(P.pkg), lock: read(P.lock), addon: read(P.addon), html: read(P.html) };
const problems = [];
const found = []; // { label, version }

if (text.pkg == null) problems.push('package.json not found');
if (text.addon == null) problems.push('src/addon.js not found');

let pkgJson;
if (text.pkg != null) {
  try { pkgJson = JSON.parse(text.pkg); } catch (e) { problems.push('package.json is not valid JSON'); }
  if (pkgJson && !SEMVER.test(pkgJson.version || '')) problems.push('package.json has no X.Y.Z "version"');
  else if (pkgJson) found.push({ label: 'package.json', version: pkgJson.version });
}
let lockJson;
if (text.lock != null) {
  try {
    lockJson = JSON.parse(text.lock);
    if (SEMVER.test(lockJson.version || '')) found.push({ label: 'package-lock.json', version: lockJson.version });
  } catch (e) { problems.push('package-lock.json is not valid JSON'); }
}
if (text.addon != null) {
  const m = text.addon.match(ADDON_RE);
  if (!m) problems.push("src/addon.js: could not find a line like  const ADDON_VERSION = '1.2.3';");
  else found.push({ label: 'src/addon.js (manifest)', version: m[3] });
}
let footerCount = 0;
if (text.html != null) {
  for (const m of text.html.matchAll(FOOTER_RE)) { footerCount++; found.push({ label: `configure.html footer #${footerCount}`, version: m[2] }); }
}
if (problems.length) fail('Cannot continue:\n  - ' + problems.join('\n  - '));

const versions = [...new Set(found.map((f) => f.version))].sort(cmp);
const highest = versions[versions.length - 1];
const drifted = versions.length > 1;

// ---- --check -------------------------------------------------------------------
if (flags.has('--check')) {
  found.forEach((f) => console.log(`  ${f.label.padEnd(28)} ${f.version}`));
  if (drifted) { console.log(`\nDRIFT: ${versions.join(', ')} - run a bump (or set an exact version) to align them.`); process.exit(1); }
  console.log(`\nAll in step at ${highest}.`); process.exit(0);
}

// ---- work out the new version --------------------------------------------------
if (!target) usage();
let next;
const [maj, min, pat] = highest.split('.').map(Number);
if (target === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (target === 'minor') next = `${maj}.${min + 1}.0`;
else if (target === 'major') next = `${maj + 1}.0.0`;
else if (SEMVER.test(target.replace(/^v/, ''))) next = target.replace(/^v/, '');
else usage();
if (cmp(next, highest) < 0) console.log(`Note: ${next} is lower than the highest version currently present (${highest}).`);
if (drifted) console.log(`Note: versions had drifted (${versions.join(', ')}); using ${highest} as the base.`);

// ---- build every new file in memory -------------------------------------------
const indentOf = (s) => (s.match(/^\{\r?\n([ \t]+)"/) || [, '  '])[1];
const eol = (s) => (s.endsWith('\n') ? '\n' : '');
const out = {};

// package.json: change only the version text, after checking it really is the top-level one
{
  const re = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  const m = text.pkg.match(re);
  if (!m || m[2] !== pkgJson.version) fail('Cannot continue:\n  - package.json: the first "version" line is not the top-level one; edit it by hand.');
  out.pkg = text.pkg.replace(re, `$1${next}$3`);
}
if (lockJson) {
  lockJson.version = next;
  if (lockJson.packages && lockJson.packages['']) lockJson.packages[''].version = next;
  out.lock = JSON.stringify(lockJson, null, indentOf(text.lock)) + eol(text.lock);
}
out.addon = text.addon.replace(ADDON_RE, `$1$2${next}$2`);
if (text.html != null && footerCount > 0) out.html = text.html.replace(FOOTER_RE, `$1${next}$3`);

// ---- report / write -------------------------------------------------------------
const changed = Object.keys(out).filter((k) => out[k] !== text[k]);
console.log(`\n${highest}  ->  ${next}${flags.has('--dry-run') ? '   (dry run: nothing written)' : ''}`);
const names = { pkg: 'package.json', lock: 'package-lock.json', addon: 'src/addon.js', html: 'public/configure.html' };
Object.keys(out).forEach((k) => console.log(`  ${changed.includes(k) ? 'updated  ' : 'unchanged'} ${names[k]}`));
if (text.lock == null) console.log('  (no package-lock.json - skipped)');
if (text.html != null && footerCount === 0) console.log('  (no footer version found in configure.html - skipped)');
if (!changed.length) { console.log(`\nAlready at ${next}; nothing to do.`); process.exit(0); }
if (flags.has('--dry-run')) process.exit(0);
changed.forEach((k) => fs.writeFileSync(P[k], out[k]));
console.log(`\nNext:  git add -A && git commit -m "Bump version to ${next}" && git push && git push beamup HEAD:main`);
