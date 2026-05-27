'use strict';
/**
 * ds-finder.js — Background worker that automatically finds and downloads
 * missing datasheet PDFs for products in the price list, warehouse, and catalog.
 *
 * Sources scanned:
 *   1. pricelist-models.json  (extracted from PRICE_LIST_DATA in dashboard.html)
 *   2. warehouse_state SQLite table (items keyed by sku)
 *   3. Catalog items sent via POST /api/admin/ds-finder/catalog (browser localStorage)
 *
 * Worker rhythm:
 *   - populateQueue() runs once on startup and every 6 hours
 *   - processQueue(5) runs every 30 seconds
 *   - Downloads: sequential, 2-second gap, max 5 attempts with exponential backoff
 */

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');
const { URL } = require('url');

const db      = require('./db');
const docpack = require('./docpack');

// ── Paths & constants ─────────────────────────────────────────────────────────
const DS_PATH      = path.resolve(process.env.DS_PATH || path.join(__dirname, 'ds'));
const PL_JSON_PATH = path.join(__dirname, 'pricelist-models.json');

const POPULATE_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const PROCESS_INTERVAL_MS  = 30 * 1000;            // 30 seconds
const DOWNLOAD_GAP_MS      = 2000;                 // 2s between requests
const MAX_ATTEMPTS         = 5;
const RETRY_DELAYS_MS = [
  1  * 60 * 60 * 1000,   // after attempt 1 → retry in 1h
  4  * 60 * 60 * 1000,   // after attempt 2 → retry in 4h
  24 * 60 * 60 * 1000,   // after attempt 3 → retry in 24h
  24 * 60 * 60 * 1000,   // after attempt 4 → retry in 24h
  // attempt 5 → mark not_found
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Worker state ──────────────────────────────────────────────────────────────
let _workerRunning   = false;
let _populateRunning = false;
let _processRunning  = false;
let _lastPopulateAt  = 0;
let _lastProcessAt   = 0;

// ── Manufacturer-SKU inference ────────────────────────────────────────────────
function _inferMfr(sku) {
  if (!sku) return null;
  if (/^DS-/i.test(sku))              return 'Hikvision';
  if (/^(IPC|NVR|XVR|UAC|PKC)\d/i.test(sku)) return 'Uniview';
  if (/^(NDI|NDE|NBE|NDP|DIP)-/i.test(sku))  return 'Bosch';
  if (/^(EH-|MPL-|T-280|AX-)/i.test(sku))    return 'SIKLU';
  if (/^RW-/i.test(sku))              return 'RADWIN';
  if (/^\d+\.?\d*C-H\d/i.test(sku))  return 'Avigilon';
  return null;
}

// ── Safe filename for saving ──────────────────────────────────────────────────
function _safeFilename(model) {
  return model.replace(/[/\\:*?"<>|\s]+/g, '_') + '.pdf';
}

// ── Save buffer to disk + trigger reindex ─────────────────────────────────────
function _safeSave(manufacturer, model, buffer) {
  const dir = path.join(DS_PATH, manufacturer);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = _safeFilename(model);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  try { docpack.buildDatasheetIndex(); } catch (_) {}
  return filePath;
}

// ── Low-level HTTP fetch ──────────────────────────────────────────────────────
// Returns a Buffer with valid PDF content, or null on any failure.
function _fetchPdf(rawUrl, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return resolve(null); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || undefined,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept':     'application/pdf,*/*',
        'Referer':    `${parsed.protocol}//${parsed.hostname}/`,
      },
      rejectUnauthorized: false, // some manufacturer CDNs have chain issues
    };

    const req = mod.request(options, (res) => {
      // Follow one level of redirect
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        res.resume();
        return _fetchPdf(res.headers.location, timeoutMs).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }

      const chunks = [];
      let checkedMagic = false;
      res.on('data', (chunk) => {
        if (!checkedMagic) {
          checkedMagic = true;
          // Accept %PDF magic bytes
          if (chunk.length >= 4 && chunk.toString('ascii', 0, 4) !== '%PDF') {
            res.destroy();
            return resolve(null);
          }
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = chunks.length ? Buffer.concat(chunks) : null;
        resolve(buf && buf.length > 1024 ? buf : null); // sanity: > 1 KB
      });
      res.on('error', () => resolve(null));
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Per-manufacturer URL builders ─────────────────────────────────────────────

function _hikvisionUrls(model) {
  const urls = [];
  const variants = [model, model.toUpperCase()];
  const stripped = model.replace(/\s*\(.*$/, ''); // strip "(2.8mm)" etc.
  if (stripped !== model) variants.push(stripped, stripped.toUpperCase());

  for (const v of variants) {
    const enc = encodeURIComponent(v);
    urls.push(
      `https://www.hikvision.com/content/dam/hikvision/en/support/resources/datasheet/${enc}-Datasheet.pdf`,
      `https://www.hikvision.com/content/dam/hikvision/en/support/resources/datasheet/${enc}.pdf`,
      `https://eu.hikvision.com/content/dam/hikvision/en/support/resources/datasheet/${enc}-Datasheet.pdf`,
      `https://eu.hikvision.com/content/dam/hikvision/en/support/resources/datasheet/${enc}.pdf`,
      `https://www.hikvision.com/content/dam/hikvision/apac/en/support/resources/datasheet/${enc}.pdf`,
    );
  }
  return urls;
}

function _univiewUrls(model) {
  const safe = _safeFilename(model).replace('.pdf', '');
  return [
    `https://sgcdn.uniview.com/uploads/soft/${encodeURIComponent(model)}.pdf`,
    `https://sgcdn.uniview.com/uploads/soft/${safe}.pdf`,
    `https://www.uniview.com/uploads/soft/${safe}.pdf`,
  ];
}

function _boschUrls(model) {
  const lower = model.toLowerCase();
  return [
    `https://resources.boschsecurity.com/s3api/downloads/datasheet-${lower}.pdf`,
    `https://media.boschsecurity.com/fs/media/en/pbm/images/products/${lower}/${lower}_DataSheet_enUS.pdf`,
    `https://media.boschsecurity.com/fs/media/en/pbm/images/products/cameras/fixed_dome_cameras/${lower}/${lower}_DataSheet_enUS.pdf`,
  ];
}

function _avigilonUrls(model, dsHint) {
  if (dsHint && dsHint.startsWith('https://')) return [dsHint];
  const norm = model.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return [
    `https://www.avigilon.com/fs/documents/avigilon-${norm}-datasheet-en.pdf`,
  ];
}

function _sikluUrls(model) {
  const safe = _safeFilename(model).replace('.pdf', '');
  return [
    `https://www.siklu.com/wp-content/uploads/datasheets/${safe}.pdf`,
    `https://www.siklu.com/wp-content/uploads/${safe}-datasheet.pdf`,
  ];
}

function _radwinUrls(model) {
  const safe = _safeFilename(model).replace('.pdf', '');
  return [
    `https://www.radwin.com/media/files/data-sheets/${safe}.pdf`,
    `https://www.radwin.com/media/files/${safe}.pdf`,
  ];
}

// ── ds-hint cache ─────────────────────────────────────────────────────────────
let _plCache = null;
function _getDsHint(model) {
  if (!_plCache) {
    try { _plCache = JSON.parse(fs.readFileSync(PL_JSON_PATH, 'utf8')); }
    catch { _plCache = []; }
  }
  const entry = _plCache.find(x => x.model === model);
  return entry ? (entry.ds || '') : '';
}

// ── Main download function ────────────────────────────────────────────────────
async function downloadDatasheet(model, manufacturer, dsHint = '') {
  // Quick check: already on disk (could have been added by another run)
  const existing = docpack.lookupDatasheet(model);
  if (existing) return { success: true, path: existing.absPath, alreadyExists: true };

  let urls = [];
  const mfr = (manufacturer || '').toLowerCase();
  if      (mfr === 'hikvision') urls = _hikvisionUrls(model);
  else if (mfr === 'uniview')   urls = _univiewUrls(model);
  else if (mfr === 'bosch')     urls = _boschUrls(model);
  else if (mfr === 'avigilon')  urls = _avigilonUrls(model, dsHint || _getDsHint(model));
  else if (mfr === 'siklu')     urls = _sikluUrls(model);
  else if (mfr === 'radwin')    urls = _radwinUrls(model);
  else return { success: false, path: null, error: `Unknown manufacturer: ${manufacturer}` };

  for (const url of urls) {
    try {
      const buf = await _fetchPdf(url);
      if (buf) {
        const savedPath = _safeSave(manufacturer, model, buf);
        console.log(`[ds-finder] ✅ ${manufacturer}/${model} <- ${url.slice(0, 80)}`);
        return { success: true, path: savedPath, url };
      }
    } catch (e) { /* try next */ }
  }
  return { success: false, path: null, error: `No PDF found (tried ${urls.length} URLs)` };
}

// ── Populate queue from price list + warehouse ────────────────────────────────
async function populateQueue() {
  if (_populateRunning) return 0;
  _populateRunning = true;
  let added = 0;

  try {
    // Source 1: price list JSON
    let plModels = [];
    try {
      plModels = JSON.parse(fs.readFileSync(PL_JSON_PATH, 'utf8'));
    } catch (e) {
      console.warn('[ds-finder] pricelist-models.json not found:', e.message);
    }

    for (const item of plModels) {
      if (!item.model || !item.mfr) continue;
      // If ds is an HTTPS URL, the downloader will use it directly — still queue it
      // If it's a relative path, check if it exists on disk first
      const dsIsUrl = (item.ds || '').startsWith('http://') || (item.ds || '').startsWith('https://');
      let alreadyOnDisk = false;
      if (!dsIsUrl && item.ds) {
        alreadyOnDisk = fs.existsSync(path.join(__dirname, item.ds));
      }
      if (!alreadyOnDisk) {
        alreadyOnDisk = !!docpack.lookupDatasheet(item.model);
      }
      if (!alreadyOnDisk) {
        const r = db.createDsQueueItem(item.model, item.mfr, 'pricelist');
        if (r.changes > 0) added++;
      }
    }

    // Source 2: warehouse items
    const wh = db.getWarehouse();
    if (wh && wh.data) {
      let items = [];
      try { items = JSON.parse(wh.data); } catch {}
      for (const item of items) {
        const sku = (item.sku || item.SKU || '').trim();
        if (!sku) continue;
        if (docpack.lookupDatasheet(sku)) continue;
        const mfr = _inferMfr(sku);
        if (!mfr) continue;
        const r = db.createDsQueueItem(sku, mfr, 'warehouse');
        if (r.changes > 0) added++;
      }
    }

    _lastPopulateAt = Date.now();
    console.log(`[ds-finder] populateQueue: +${added} new items queued`);
  } catch (e) {
    console.error('[ds-finder] populateQueue error:', e.message);
  } finally {
    _populateRunning = false;
  }
  return added;
}

// ── Process queue ─────────────────────────────────────────────────────────────
async function processQueue(limit = 5) {
  if (_processRunning) return { processed: 0, found: 0, failed: 0 };
  _processRunning = true;
  let processed = 0, found = 0, failed = 0;

  try {
    const items = db.listDsQueuePending(limit);
    for (const item of items) {
      // Exceeded max attempts → give up
      if ((item.attempts || 0) >= MAX_ATTEMPTS) {
        db.markDsQueueNotFound(item.id);
        processed++;
        continue;
      }

      const result = await downloadDatasheet(
        item.model, item.manufacturer, _getDsHint(item.model)
      );

      if (result.success) {
        db.markDsQueueFound(item.id, result.path || 'on-disk');
        found++;
      } else if (result.error && result.error.startsWith('Unknown manufacturer')) {
        db.markDsQueueNotFound(item.id);
      } else {
        const attempt = (item.attempts || 0) + 1;
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        const next = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').slice(0, 19);
        db.markDsQueueError(item.id, result.error, next);
        failed++;
      }
      processed++;

      if (processed < items.length) {
        await new Promise(r => setTimeout(r, DOWNLOAD_GAP_MS));
      }
    }
    _lastProcessAt = Date.now();
    if (processed > 0) {
      console.log(`[ds-finder] processQueue: ${processed} processed, ${found} found, ${failed} failed`);
    }
  } catch (e) {
    console.error('[ds-finder] processQueue error:', e.message);
  } finally {
    _processRunning = false;
  }
  return { processed, found, failed };
}

// ── Add catalog items from browser ────────────────────────────────────────────
function addCatalogItems(items) {
  let added = 0;
  for (const item of (items || [])) {
    const model = (item.model || item.sku || '').trim();
    if (!model) continue;
    const mfr = item.mfr || _inferMfr(model);
    if (!mfr) continue;
    if (docpack.lookupDatasheet(model)) continue;
    const r = db.createDsQueueItem(model, mfr, 'catalog');
    if (r.changes > 0) added++;
  }
  return added;
}

// ── Status ─────────────────────────────────────────────────────────────────────
function getStatus() {
  const stats = db.getDsQueueStats() || {};
  return {
    stats: {
      pending:   stats.pending   || 0,
      found:     stats.found     || 0,
      not_found: stats.not_found || 0,
      error:     stats.error     || 0,
      total:     stats.total     || 0,
    },
    lastPopulateAt:  _lastPopulateAt  ? new Date(_lastPopulateAt).toISOString()  : null,
    lastProcessAt:   _lastProcessAt   ? new Date(_lastProcessAt).toISOString()   : null,
    workerRunning:   _workerRunning,
    populateRunning: _populateRunning,
    processRunning:  _processRunning,
  };
}

// ── Worker start ──────────────────────────────────────────────────────────────
function startWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  console.log('[ds-finder] Worker starting (populate every 6h, process every 30s)');

  // Initial populate (deferred so server finishes booting first)
  setImmediate(() => populateQueue().catch(e =>
    console.error('[ds-finder] initial populate error:', e.message)
  ));

  // Process queue every 30 seconds
  const processTimer = setInterval(() => {
    processQueue(5).catch(e => console.error('[ds-finder] process error:', e.message));
  }, PROCESS_INTERVAL_MS);
  if (processTimer.unref) processTimer.unref();

  // Re-populate every 6 hours to pick up new items
  const populateTimer = setInterval(() => {
    populateQueue().catch(e => console.error('[ds-finder] populate error:', e.message));
  }, POPULATE_INTERVAL_MS);
  if (populateTimer.unref) populateTimer.unref();
}

module.exports = {
  startWorker,
  populateQueue,
  processQueue,
  downloadDatasheet,
  addCatalogItems,
  getStatus,
};
