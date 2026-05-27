/**
 * scripts/extract-pricelist-models.js
 *
 * One-time (and on-demand) script that extracts {mfr, model, ds} entries
 * from the PRICE_LIST_DATA constant in dashboard.html and writes them to
 * pricelist-models.json in the project root.
 *
 * Run: node scripts/extract-pricelist-models.js
 * Re-run any time you edit PRICE_LIST_DATA in dashboard.html.
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const rootDir   = path.join(__dirname, '..');
const htmlPath  = path.join(rootDir, 'dashboard.html');
const outPath   = path.join(rootDir, 'pricelist-models.json');

const html = fs.readFileSync(htmlPath, 'utf8');

// Locate the start of the array literal
const MARKER = 'const PRICE_LIST_DATA = ';
const markerIdx = html.indexOf(MARKER);
if (markerIdx === -1) {
  console.error('ERROR: PRICE_LIST_DATA constant not found in dashboard.html');
  process.exit(1);
}

const arrayStart = html.indexOf('[', markerIdx);
if (arrayStart === -1) {
  console.error('ERROR: could not find opening [ for PRICE_LIST_DATA');
  process.exit(1);
}

// Bracket-match to find the end of the array
let depth = 0;
let arrayEnd = -1;
for (let i = arrayStart; i < html.length; i++) {
  const c = html[i];
  if      (c === '[') depth++;
  else if (c === ']') { depth--; if (depth === 0) { arrayEnd = i; break; } }
}
if (arrayEnd === -1) {
  console.error('ERROR: could not find closing ] for PRICE_LIST_DATA');
  process.exit(1);
}

const arrayStr = html.slice(arrayStart, arrayEnd + 1);

// Evaluate safely in a sandboxed context
const sandbox = {};
try {
  vm.runInNewContext(`data = ${arrayStr}`, sandbox);
} catch (e) {
  console.error('ERROR evaluating PRICE_LIST_DATA:', e.message);
  process.exit(1);
}

const raw = sandbox.data;
if (!Array.isArray(raw)) {
  console.error('ERROR: evaluated value is not an array');
  process.exit(1);
}

// Extract only the fields the ds-finder needs
const models = raw
  .map(item => ({
    mfr:   (item.mfr   || '').trim(),
    model: (item.model || '').trim(),
    ds:    (item.ds    || '').trim(),
  }))
  .filter(x => x.mfr && x.model);

// Deduplicate by (mfr, model)
const seen = new Set();
const unique = models.filter(x => {
  const key = `${x.mfr}||${x.model}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

fs.writeFileSync(outPath, JSON.stringify(unique, null, 2), 'utf8');
console.log(`✅ Extracted ${unique.length} unique (mfr, model) entries → pricelist-models.json`);

// Print a quick breakdown by manufacturer
const byMfr = {};
for (const x of unique) { byMfr[x.mfr] = (byMfr[x.mfr] || 0) + 1; }
for (const [mfr, n] of Object.entries(byMfr).sort((a,b) => b[1]-a[1])) {
  const hasDsCount = unique.filter(x => x.mfr === mfr && x.ds).length;
  console.log(`  ${mfr.padEnd(12)} ${String(n).padStart(4)} items  (${hasDsCount} with existing ds url)`);
}
