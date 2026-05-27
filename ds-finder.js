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
let _puppeteerBusy   = false; // only one Chrome instance at a time
let _currentModel    = null;  // model currently being downloaded (shown in UI)
let _workerPaused    = false; // pause gate — intervals keep running but processQueue no-ops

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
// Follows up to 5 redirects (handles multi-hop CDN chains).
// Fetch a URL and return the response body as a UTF-8 string (for HTML pages)
function _fetchHtml(rawUrl, timeoutMs = 15000) {
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
        'User-Agent':      BROWSER_UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    const req = mod.request(options, (res) => {
      // Follow one redirect only
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try {
          const loc = new URL(res.headers.location, rawUrl).href;
          return _fetchHtml(loc, timeoutMs).then(resolve);
        } catch { return resolve(null); }
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data',  (c) => { if (Buffer.concat(chunks).length < 512 * 1024) chunks.push(c); });
      res.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(null));
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Search DuckDuckGo HTML for "<model>.PDF" and return up to maxResults direct PDF URLs.
// DuckDuckGo HTML endpoint returns links encoded as uddg= query params — no JS required.
async function _searchPdfUrls(model, maxResults = 5) {
  const query = encodeURIComponent(model + '.PDF');
  const searchUrl = `https://html.duckduckgo.com/html/?q=${query}`;
  try {
    const html = await _fetchHtml(searchUrl, 15000);
    if (!html) return [];

    const urls = [];
    // Each result link looks like: href="//duckduckgo.com/l/?uddg=https%3A%2F%2F...&rut=..."
    const uddgRe = /uddg=([^&"'\s>]+)/gi;
    let m;
    while ((m = uddgRe.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (/^https?:\/\/.+\.pdf(\?|#|$)/i.test(decoded) && !urls.includes(decoded)) {
          urls.push(decoded);
        }
      } catch { /* bad encoding, skip */ }
      if (urls.length >= maxResults) break;
    }
    if (urls.length) console.log(`[ds-finder] 🔍 DDG "${model}.PDF" → ${urls.length} PDF URL(s)`);
    return urls;
  } catch (e) {
    console.warn('[ds-finder] DDG search error:', e.message);
    return [];
  }
}

function _fetchPdf(rawUrl, timeoutMs = 25000, _redirects = 0) {
  if (_redirects > 5) return Promise.resolve(null); // redirect loop guard

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
        'User-Agent':      BROWSER_UA,
        'Accept':          'application/pdf,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         `${parsed.protocol}//${parsed.hostname}/`,
      },
      rejectUnauthorized: false, // some manufacturer CDNs have chain issues
    };

    const req = mod.request(options, (res) => {
      // Follow redirects (301/302/303/307/308)
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
      if (isRedirect && res.headers.location) {
        res.resume();
        // Resolve relative redirect URLs against original host
        let loc = res.headers.location;
        try { loc = new URL(loc, rawUrl).href; } catch { return resolve(null); }
        return _fetchPdf(loc, timeoutMs, _redirects + 1).then(resolve);
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
  // Build model variants to try (small set — each costs 2s in the queue)
  const variants = new Set([model]);
  const upper = model.toUpperCase();
  if (upper !== model) variants.add(upper);

  // Strip trailing lens suffix like "(2.8mm)", "(F2.8)", "(2.8-12mm)"
  const stripped = model.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== model) {
    variants.add(stripped);
    if (stripped.toUpperCase() !== upper) variants.add(stripped.toUpperCase());
  }

  const urls = [];
  const BASE = 'content/dam/hikvision/en/support/resources/datasheet';

  for (const v of [...variants]) {
    const enc = encodeURIComponent(v);
    // www and EU domains — most datasheets are on one of these two
    for (const domain of ['https://www.hikvision.com', 'https://eu.hikvision.com']) {
      urls.push(
        `${domain}/${BASE}/${enc}-Datasheet.pdf`,    // most common
        `${domain}/${BASE}/${enc}_Datasheet.pdf`,    // some newer models use underscore
        `${domain}/${BASE}/${enc}.pdf`,              // bare filename fallback
        `${domain}/${BASE}/${enc}-Datasheet-EN.pdf`, // English-tagged variant
      );
    }
    // APAC mirror (covers ANZ / SEA region stock)
    urls.push(
      `https://www.hikvision.com/content/dam/hikvision/apac/en/support/resources/datasheet/${enc}-Datasheet.pdf`,
      `https://www.hikvision.com/content/dam/hikvision/apac/en/support/resources/datasheet/${enc}.pdf`,
    );
  }

  // Deduplicate while preserving order
  return [...new Set(urls)];
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

// ── Puppeteer fallback for Hikvision ─────────────────────────────────────────
// Used when all direct content/dam URL attempts fail.
// Navigates to the Hikvision product page in a real browser and extracts the
// actual download URL (which may be on assets.hikvision.com with an opaque ID).
async function _hikvisionPuppeteer(model) {
  if (_puppeteerBusy) return null; // don't stack Chrome instances

  let puppeteerMod;
  try { puppeteerMod = require('puppeteer'); }
  catch { return null; } // package not installed

  _puppeteerBusy = true;
  let browser;
  try {
    browser = await puppeteerMod.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // use /tmp instead of /dev/shm (crucial for Render)
        '--disable-gpu',
        '--no-zygote',
        '--single-process',        // reduces memory on constrained environments
        '--disable-extensions',
      ],
      timeout: 30000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_UA);
    page.setDefaultTimeout(20000);

    // 1. Search for the product
    const searchUrl = `https://www.hikvision.com/en/search/?q=${encodeURIComponent(model)}&active=Products`;
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch { return null; }

    // 2. Find the first specific product page link in the results
    const productUrl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const parts = a.href.split('/');
        if (
          a.href.includes('hikvision.com/en/products/') &&
          parts.length >= 8 &&
          !a.href.match(/\/products\/?$/)
        ) {
          return a.href;
        }
      }
      return null;
    });
    if (!productUrl) { console.log(`[ds-finder] puppeteer: no product page for ${model}`); return null; }

    // 3. Navigate to the product page
    try {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch { return null; }

    // 4. Click "Downloads" tab if present, then wait for tab content
    const clickedTab = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, button, [role="tab"], li, span')) {
        if (/^downloads?$/i.test(el.textContent.trim())) { el.click(); return true; }
      }
      return false;
    });
    if (clickedTab) await new Promise(r => setTimeout(r, 2000));

    // 5. Find a datasheet PDF link
    const pdfUrl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        const text = a.textContent.toLowerCase();
        // Direct assets CDN URL with opaque doc ID
        if (href.includes('assets.hikvision.com') && href.includes('/doc/')) return href;
        // content/dam PDF with "datasheet" in path or text
        if (href.toLowerCase().endsWith('.pdf') &&
            (href.toLowerCase().includes('datasheet') || text.includes('datasheet'))) {
          return href;
        }
      }
      return null;
    });

    if (!pdfUrl) { console.log(`[ds-finder] puppeteer: no PDF link found for ${model}`); return null; }
    console.log(`[ds-finder] puppeteer found URL for ${model}: ${pdfUrl.slice(0, 90)}`);

    // 6. Download via server-side fetch (CDN links are public)
    return await _fetchPdf(pdfUrl, 30000);

  } catch (e) {
    console.error(`[ds-finder] puppeteer error for ${model}:`, e.message.slice(0, 120));
    return null;
  } finally {
    _puppeteerBusy = false;
    if (browser) { try { await browser.close(); } catch { } }
  }
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

  // Hikvision last resort: use headless browser to find the real download URL
  if (mfr === 'hikvision') {
    try {
      const buf = await _hikvisionPuppeteer(model);
      if (buf) {
        const savedPath = _safeSave(manufacturer, model, buf);
        console.log(`[ds-finder] ✅ ${manufacturer}/${model} via puppeteer`);
        return { success: true, path: savedPath, url: 'puppeteer' };
      }
    } catch { /* puppeteer failed, fall through */ }
  }

  // Universal last resort: search DuckDuckGo for "<model>.PDF" and try the first results
  try {
    const searchUrls = await _searchPdfUrls(model, 5);
    for (const sUrl of searchUrls) {
      try {
        const buf = await _fetchPdf(sUrl, 20000);
        if (buf) {
          const savedPath = _safeSave(manufacturer, model, buf);
          console.log(`[ds-finder] ✅ ${manufacturer}/${model} via DDG search <- ${sUrl.slice(0, 80)}`);
          return { success: true, path: savedPath, url: sUrl };
        }
      } catch { /* try next search result */ }
    }
  } catch { /* search failed entirely */ }

  return { success: false, path: null, error: `No PDF found (tried ${urls.length} direct URLs + DDG search)` };
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

    // Check if any previously-found items have had their file deleted from disk.
    // If the datasheet can no longer be found, reset to pending so it gets re-downloaded.
    let reset = 0;
    try {
      const foundItems = db.listDsQueue('found', 9999);
      for (const item of foundItems) {
        const onDisk = docpack.lookupDatasheet(item.model);
        if (!onDisk) {
          // Also check the stored path directly if lookup didn't find it
          const pathOk = item.found_path && fs.existsSync(item.found_path);
          if (!pathOk) {
            db.resetDsQueueFoundItem(item.id);
            reset++;
          }
        }
      }
      if (reset > 0) console.log(`[ds-finder] populateQueue: reset ${reset} found→pending (files missing)`);
    } catch (e) {
      console.warn('[ds-finder] found-items check error:', e.message);
    }

    _lastPopulateAt = Date.now();
    console.log(`[ds-finder] populateQueue: +${added} new, ${reset} re-queued (missing files)`);
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
  if (_workerPaused)   return { processed: 0, found: 0, failed: 0 };
  _processRunning = true;
  let processed = 0, found = 0, failed = 0;

  try {
    // Respect per-manufacturer enabled/disabled settings
    const mfrSettings = db.listDsFinderManufacturers();
    const disabledMfrs = new Set(
      mfrSettings.filter(s => !s.enabled).map(s => (s.manufacturer || '').toLowerCase())
    );

    // Fetch a larger batch then filter out disabled manufacturers
    const allPending = db.listDsQueuePending(limit * 4);
    const items = allPending
      .filter(it => !disabledMfrs.has((it.manufacturer || '').toLowerCase()))
      .slice(0, limit);

    for (const item of items) {
      if (_workerPaused) break; // respect mid-loop pause

      // Exceeded max attempts → give up
      if ((item.attempts || 0) >= MAX_ATTEMPTS) {
        db.markDsQueueNotFound(item.id);
        processed++;
        continue;
      }

      _currentModel = item.model; // expose to status API
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
    _currentModel   = null;
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
    currentModel:    _currentModel,
    paused:          _workerPaused,
  };
}

function pauseWorker()  { _workerPaused = true;  console.log('[ds-finder] Worker paused'); }
function resumeWorker() { _workerPaused = false; console.log('[ds-finder] Worker resumed'); }

// Mark a queue item as found (best-effort — won't throw)
function _markQueueItemFound(model, savedPath) {
  try {
    const rows = db.listDsQueueActive(9999);
    const row = rows.find(r => r.model === model);
    if (row) db.markDsQueueFound(row.id, savedPath);
  } catch { /* best-effort */ }
}

// Download a PDF from a user-supplied URL and save it immediately (bypasses queue order).
// If the supplied URL fails (auth wall, bot block, wrong content), automatically falls back
// to a DuckDuckGo search for "<model>.PDF" and tries those URLs.
async function downloadFromUrl(model, manufacturer, url) {
  if (!model || !manufacturer || !url) {
    return { success: false, error: 'model, manufacturer and url are required' };
  }
  try {
    // 1. Try the user-supplied URL first
    const buf = await _fetchPdf(url, 30000);
    if (buf) {
      const savedPath = _safeSave(manufacturer, model, buf);
      _markQueueItemFound(model, savedPath);
      console.log(`[ds-finder] ✅ manual: ${manufacturer}/${model} <- ${url.slice(0, 80)}`);
      return { success: true, path: savedPath };
    }

    // 2. User URL returned non-PDF (auth wall, HTML, etc.) — try DDG search automatically
    console.log(`[ds-finder] manual URL returned no PDF for ${model}, trying DDG search...`);
    const searchUrls = await _searchPdfUrls(model, 5);
    for (const sUrl of searchUrls) {
      if (sUrl === url) continue; // don't retry the same URL
      try {
        const sBuf = await _fetchPdf(sUrl, 20000);
        if (sBuf) {
          const savedPath = _safeSave(manufacturer, model, sBuf);
          _markQueueItemFound(model, savedPath);
          console.log(`[ds-finder] ✅ manual DDG fallback: ${manufacturer}/${model} <- ${sUrl.slice(0, 80)}`);
          return { success: true, path: savedPath, foundViaSearch: true, searchUrl: sUrl };
        }
      } catch { /* try next */ }
    }

    // 3. Everything failed — explain why in Hebrew
    return {
      success: false,
      error: 'הכתובת לא החזירה PDF תקין (ייתכן שהאתר דורש התחברות, או שחסם גישה אוטומטית). גם חיפוש אוטומטי לא מצא קובץ. נסה לינק ישיר מאתר היצרן הרשמי.',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
  pauseWorker,
  resumeWorker,
  downloadFromUrl,
};
