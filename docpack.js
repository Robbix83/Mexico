/**
 * docpack.js — Word document generation for "תיק תיעוד" portfolios
 *
 * Uses docxtemplater + pizzip + docxtemplater-image-module-free.
 * Templates live in ./templates/<type>.docx (commit-time, not user-uploaded in MVP).
 * Photos live in <UPLOADS_DIR>/<pack_id>/<filename>.
 *
 * ─── Placeholder schema (single source of truth) ────────────────────────────
 * Text fields:
 *   {site_name}             — שם האתר
 *   {site_address}          — כתובת
 *   {site_subtitle}         — שורת תיאור משנית בכותרת
 *   {contractor_org}        — גורם מבצע (חברה)
 *   {contractor_person}     — גורם מבצע (איש קשר)
 *   {pm_org}                — גורם מוביל (חברה)
 *   {pm_person}             — גורם מוביל / מנהל פרויקט (איש קשר)
 *   {customer_org}          — לקוח סופי (ארגון)
 *   {customer_person}       — לקוח סופי (איש קשר)
 *   {consultant_org}        — יועץ טכנולוגי (חברה)
 *   {consultant_person}     — יועץ טכנולוגי (איש קשר)
 *   {engineer_org}          — מהנדס טכנולוגי (חברה)
 *   {engineer_person}       — מהנדס טכנולוגי (איש קשר)
 *   {submit_date}           — תאריך הגשה
 *   {update_date}           — תאריך עדכון
 *   {intro_text}            — הקדמה (טקסט חופשי, multi-paragraph שנקטע בפסקאות)
 *   {network_arch_text}     — תיאור ארכיטקטורת רשת
 *
 * Loops:
 *   {#scope_items}{text}{/scope_items}         — תכולת הפרויקט (bullets)
 *   {#cameras}{idx},{cabinet},{name},{model},{port},{ip},{location}{/cameras}
 *   {#backhauls}{idx},{type},{mpn},{vendor},{location},{ip}{/backhauls}
 *   {#switches}{idx},{name},{mpn},{vendor},{ip}{/switches}
 *   {#photos}{%img}{caption}{/photos}          — תמונות AS-MADE
 *
 * Image tags (use `%` prefix, image module):
 *   {%network_diagram_img}   — דיאגרמת רשת (one)
 *   {%site_plan_img}         — תכנית אתר (one)
 *   inside {#photos}: {%img} — תמונה ל-loop
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const PizZip          = require('pizzip');
const Docxtemplater   = require('docxtemplater');
const ImageModule     = require('docxtemplater-image-module-free');
// pdf-to-img is ESM-only; load it lazily via dynamic import on first use
let _pdfToImg = null;
async function _getPdfToImg() {
  if (!_pdfToImg) _pdfToImg = (await import('pdf-to-img')).pdf;
  return _pdfToImg;
}
const db = require('./db');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const UPLOADS_DIR   = process.env.DOC_PACK_UPLOADS_DIR || path.join(__dirname, 'data', 'doc_packs');
// Datasheets live under DS_PATH (mirrored on Render's persistent disk).
const DS_PATH       = path.resolve(process.env.DS_PATH || path.join(__dirname, 'ds'));
const DS_FALLBACK   = path.join(__dirname, 'ds'); // git-committed PDFs if DS_PATH is empty

// Ensure uploads dir exists at module load
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function templatePath(type) {
  return path.join(TEMPLATES_DIR, `${type || 'cctv'}.docx`);
}

function packDir(packId) {
  const d = path.join(UPLOADS_DIR, String(packId));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileDiskPath(packId, filename) {
  return path.join(packDir(packId), filename);
}

// ── PDF page rendering ─────────────────────────────────────────────────────
// Each datasheet PDF is rendered to PNG pages at export time so they can be
// inlined into the Word document. Rendered images are written to a temp dir
// under UPLOADS_DIR/_pdfrender so the existing image module reads them off
// disk just like uploaded photos. Caller is responsible for cleaning the dir.

const PDF_RENDER_TEMP_DIR = path.join(UPLOADS_DIR, '_pdfrender');
const PDF_RENDER_MAX_PAGES_PER_DOC   = 10;  // safety: don't blow up the docx
const PDF_RENDER_MAX_PAGES_TOTAL     = 50;  // overall cap across all datasheets
const PDF_RENDER_SCALE               = 1.5; // 1.0 = 72 DPI; 1.5 ≈ 108 DPI — good balance

async function renderPdfToPngs(pdfPath, outDir, opts = {}) {
  const maxPages = opts.maxPages || PDF_RENDER_MAX_PAGES_PER_DOC;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const pdf = await _getPdfToImg();
  const doc = await pdf(pdfPath, { scale: PDF_RENDER_SCALE });
  const out = [];
  let i = 0;
  for await (const pngBuffer of doc) {
    i++;
    if (i > maxPages) break;
    const outPath = path.join(outDir, `${path.basename(pdfPath, '.pdf')}_${i}.png`);
    fs.writeFileSync(outPath, pngBuffer);
    out.push({ path: outPath, page: i });
  }
  return out;
}

function _cleanupRenderDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    fs.rmdirSync(dir);
  } catch {/* best effort */}
}

// ─── Datasheet index ───────────────────────────────────────────────────────
// On boot (and every 5 min), walk DS_PATH recursively and build a map:
//   normalizedKey  →  { absPath, mfr, original }
// The key is the filename without extension, uppercased, with spaces/dashes/
// underscores stripped — so "DS-1272ZJ-110" and "DS 1272 ZJ 110" both match.
let _dsIndex = new Map();
let _dsIndexBuiltAt = 0;

function _normalizeModel(s) {
  return String(s || '').toUpperCase().replace(/[\s_\-\.\/\\]+/g, '');
}

function _walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { _walk(full, out); continue; }
    if (!ent.isFile()) continue;
    if (!/\.pdf$/i.test(ent.name)) continue;
    const stem = ent.name.replace(/\.pdf$/i, '');
    const mfr  = path.basename(path.dirname(full)); // e.g. "Hikvision"
    out.push({ key: _normalizeModel(stem), original: stem, mfr, absPath: full });
  }
}

function buildDatasheetIndex() {
  const list = [];
  for (const root of [DS_PATH, DS_FALLBACK]) {
    if (fs.existsSync(root)) _walk(root, list);
  }
  const map = new Map();
  for (const item of list) {
    // Keep the first occurrence (DS_PATH takes priority since we walk it first)
    if (!map.has(item.key)) map.set(item.key, item);
  }
  _dsIndex = map;
  _dsIndexBuiltAt = Date.now();
  console.log(`[docpack] datasheet index built: ${map.size} entries`);
  return map.size;
}

function ensureDsIndex() {
  // Rebuild lazily if older than 5 minutes
  if (!_dsIndex.size || Date.now() - _dsIndexBuiltAt > 5 * 60 * 1000) {
    buildDatasheetIndex();
  }
}

function lookupDatasheet(modelString) {
  ensureDsIndex();
  if (!modelString) return null;
  const key = _normalizeModel(modelString);
  return _dsIndex.get(key) || null;
}

function searchDatasheets(query, limit = 10) {
  ensureDsIndex();
  if (!query || !query.trim()) return [];
  const q = _normalizeModel(query);
  const hits = [];
  for (const item of _dsIndex.values()) {
    if (item.key === q) { hits.unshift({ ...item, exact: true }); }       // exact first
    else if (item.key.includes(q) || q.includes(item.key)) hits.push({ ...item, exact: false });
    if (hits.length >= limit * 2) break;
  }
  return hits.slice(0, limit).map(h => ({
    model:    h.original,
    mfr:      h.mfr,
    relPath:  path.relative(path.dirname(h.absPath).split(path.sep).includes('ds') ? path.dirname(path.dirname(h.absPath)) : DS_PATH, h.absPath).split(path.sep).join('/'),
    exact:    h.exact,
  }));
}

// Re-index every 5 min so PDFs added later are discovered without a restart
setInterval(() => { try { buildDatasheetIndex(); } catch (e) { /* swallow */ } }, 5 * 60 * 1000).unref?.();

/**
 * imageModuleOpts() — returns options object for docxtemplater-image-module-free.
 *
 * `getImage(tagValue)` reads from disk. The tag value is the absolute file path
 *  produced by buildContext (e.g. /data/doc_packs/3/abc123.jpg).
 * `getSize(_, tagValue, tagName)` returns [widthPx, heightPx] for the image
 *  inside the document. We use 600×400 for photos and 720×400 for diagrams.
 */
function imageModuleOpts() {
  return {
    centered: false,
    getImage(tagValue) {
      if (!tagValue || !fs.existsSync(tagValue)) {
        // Return a 1×1 transparent PNG so docxtemplater doesn't blow up
        return Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
          'base64'
        );
      }
      return fs.readFileSync(tagValue);
    },
    getSize(_img, tagValue, tagName) {
      // PDF-rendered datasheet pages: keep the actual rendered aspect ratio
      // (pdf-to-img returns the original page proportions). Width fits the
      // page area (approx 620px in Word at default margins), height auto-
      // computed from the PNG dimensions.
      if (tagName === 'page_img' || /pdf_/i.test(String(tagValue))) {
        try {
          // Read PNG width/height from the IHDR chunk (offsets 16-24)
          const buf = fs.readFileSync(tagValue);
          if (buf.length >= 24) {
            const w = buf.readUInt32BE(16);
            const h = buf.readUInt32BE(20);
            const targetW = 620;
            const targetH = Math.round(h * (targetW / w));
            return [targetW, targetH];
          }
        } catch {}
        return [620, 800];
      }
      if (tagName && /diagram|plan/i.test(tagName)) return [620, 380];
      return [560, 380]; // default photo size
    },
  };
}

/**
 * buildContext(pack, files, opts) — produces the placeholder context for
 * docxtemplater. `opts.renderTempDir` is where PDF-rendered pages go (caller
 * cleans up). If `opts.renderTempDir` is omitted, datasheets are listed by
 * name only (no pages embedded) — used by dry-render at boot.
 *
 * Returns a Promise<context> because PDF rendering is async.
 */
async function buildContext(pack, files, opts = {}) {
  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch { data = {}; }

  const scope_items = (data.scope_items || []).filter(s => s && s.trim()).map(text => ({ text }));

  const cameras = (data.cameras || []).map((r, i) => ({
    idx:      r.idx      || (i + 1),
    cabinet:  r.cabinet  || '',
    name:     r.name     || '',
    model:    r.model    || '',
    port:     r.port     || '',
    ip:       r.ip       || '',
    location: r.location || '',
  }));

  const backhauls = (data.backhauls || []).map((r, i) => ({
    idx:      r.idx      || (i + 1),
    type:     r.type     || '',
    mpn:      r.mpn      || '',
    vendor:   r.vendor   || '',
    location: r.location || '',
    ip:       r.ip       || '',
  }));

  const switches = (data.switches || []).map((r, i) => ({
    idx:    r.idx    || (i + 1),
    name:   r.name   || '',
    mpn:    r.mpn    || '',
    vendor: r.vendor || '',
    ip:     r.ip     || '',
  }));

  // ── Images / files ──
  // Only client-visible files reach the rendered Word doc; internal artifacts
  // (price quotes, working drafts) stay in the workspace but not in the deliverable.
  const allFiles = (files || []).filter(f => (f.visibility || 'client') === 'client');

  const findFirst = (kind) => allFiles.find(f => f.kind === kind);
  const network = findFirst('network_diagram');
  const sitepl  = findFirst('site_plan');

  const photoRows = allFiles
    .filter(f => f.kind === 'photo')
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));

  // Datasheets / PDFs: render every page to PNG and embed inline in Word
  // so the client opens a single .docx and sees everything.
  const pdfFiles = allFiles.filter(f =>
    f.kind === 'datasheet' || f.kind === 'pdf' ||
    /\.pdf$/i.test(f.original_name || '')
  );
  const datasheets = [];
  let totalPagesRendered = 0;
  if (opts.renderTempDir && pdfFiles.length) {
    for (const f of pdfFiles) {
      if (totalPagesRendered >= PDF_RENDER_MAX_PAGES_TOTAL) break;
      const src = f.filename ? fileDiskPath(f.pack_id, f.filename) : f.external_path;
      if (!src || !fs.existsSync(src)) continue;
      let pages = [];
      try {
        const remaining = PDF_RENDER_MAX_PAGES_TOTAL - totalPagesRendered;
        const maxPages = Math.min(PDF_RENDER_MAX_PAGES_PER_DOC, remaining);
        pages = await renderPdfToPngs(src, opts.renderTempDir, { maxPages });
        totalPagesRendered += pages.length;
      } catch (e) {
        console.warn('[docpack] PDF render failed for', src, e.message);
      }
      datasheets.push({
        name: f.original_name || (f.external_path ? path.basename(f.external_path) : f.filename),
        mfr:  f.caption || '',
        pages: pages.map(p => ({ page_img: p.path, page_num: p.page })),
      });
    }
  } else if (pdfFiles.length) {
    // Dry-render / no-render path: just list names, no page images
    for (const f of pdfFiles) {
      datasheets.push({
        name: f.original_name || (f.external_path ? path.basename(f.external_path) : f.filename),
        mfr:  f.caption || '',
        pages: [],
      });
    }
  }

  return {
    site_name:        data.site_name        || pack.name || '',
    site_address:     data.site_address     || '',
    site_subtitle:    data.site_subtitle    || '',
    contractor_org:   data.contractor_org   || '',
    contractor_person:data.contractor_person|| '',
    pm_org:           data.pm_org           || '',
    pm_person:        data.pm_person        || '',
    customer_org:     data.customer_org     || '',
    customer_person:  data.customer_person  || '',
    consultant_org:   data.consultant_org   || '',
    consultant_person:data.consultant_person|| '',
    engineer_org:     data.engineer_org     || '',
    engineer_person:  data.engineer_person  || '',
    submit_date:      data.submit_date      || '',
    update_date:      data.update_date      || '',
    intro_text:       data.intro_text       || '',
    network_arch_text:data.network_arch_text|| '',
    scope_items,
    cameras,
    backhauls,
    switches,
    // Image tag values are absolute paths; getImage() reads them
    network_diagram_img: network ? _imgSourcePath(network) : '',
    site_plan_img:       sitepl  ? _imgSourcePath(sitepl)  : '',
    photos: photoRows.map(p => ({
      img:     _imgSourcePath(p),
      caption: p.caption || '',
    })),
    datasheets,
    // Useful flags for conditional sections inside the template
    has_cameras:   cameras.length     > 0,
    has_backhauls: backhauls.length   > 0,
    has_switches:  switches.length    > 0,
    has_photos:    photoRows.length   > 0,
    has_network_diagram: !!network,
    has_site_plan:       !!sitepl,
    has_datasheets: datasheets.length > 0,
  };
}

// Image source: prefer uploaded file (under UPLOADS_DIR); fall back to external_path
// (used for datasheets auto-linked from /data/ds/...). Used by image insertion AND
// by the ZIP packager so both code paths read the same source.
function _imgSourcePath(file) {
  if (file.filename)      return fileDiskPath(file.pack_id, file.filename);
  if (file.external_path) return file.external_path;
  return '';
}

/**
 * generateDocPack(packId) — produces a single .docx file with all client-
 * visible PDFs (datasheets) rendered as inline images in an appendix section.
 * Returns a Promise<Buffer> containing the .docx bytes.
 */
async function generateDocPack(packId) {
  const pack = db.getDocPack(packId);
  if (!pack) {
    const e = new Error('Pack not found'); e.code = 'PACK_NOT_FOUND';
    throw e;
  }
  const tplPath = templatePath(pack.type);
  if (!fs.existsSync(tplPath)) {
    const e = new Error(`Template missing: ${path.basename(tplPath)}`); e.code = 'TEMPLATE_MISSING';
    throw e;
  }
  const files = db.listDocPackFiles(packId);

  // Per-export temp dir for PDF-rendered PNGs; cleaned up after render
  const renderTempDir = path.join(PDF_RENDER_TEMP_DIR, crypto.randomBytes(8).toString('hex'));

  try {
    const context = await buildContext(pack, files, { renderTempDir });
    const content = fs.readFileSync(tplPath, 'binary');
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      modules: [new ImageModule(imageModuleOpts())],
      errorLogging: 'json',
    });
    doc.render(context);
    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  } finally {
    _cleanupRenderDir(renderTempDir);
  }
}

/**
 * dryRenderAllTemplates() — boot-time sanity check; renders every template
 * in TEMPLATES_DIR with empty sample data so we catch malformed templates
 * before the first user request. Logs results; does not throw.
 */
async function dryRenderAllTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.log('[docpack] templates/ dir not found — skipping dry-render');
    return;
  }
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.toLowerCase().endsWith('.docx'));
  if (!files.length) {
    console.log('[docpack] no templates found in templates/ — skipping dry-render');
    return;
  }
  const samplePack = { id: 0, name: 'דוגמה', type: 'cctv', data: '{}' };
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'binary');
      const zip = new PizZip(content);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        modules: [new ImageModule(imageModuleOpts())],
      });
      // No renderTempDir → datasheets list only, no PDFs rendered
      const ctx = await buildContext(samplePack, []);
      doc.render(ctx);
      console.log(`[docpack] ✓ template ${f} dry-renders OK`);
    } catch (e) {
      console.error(`[docpack] ✗ template ${f} FAILED dry-render:`, e.message);
      if (e.properties && e.properties.errors) {
        for (const err of e.properties.errors.slice(0, 5)) {
          console.error('  -', err.message);
        }
      }
    }
  }
}

/**
 * sweepAndAttachDatasheets(packId, contributor) — pre-export hook that walks
 * the pack's equipment tables (cameras/backhauls/switches) and, for any model
 * we recognize but haven't attached yet, inserts a datasheet doc_pack_files
 * row pointing at the on-disk PDF.
 *
 * Idempotent: safe to call multiple times. Returns the count of newly
 * attached datasheets.
 */
function sweepAndAttachDatasheets(packId, contributor) {
  const pack = db.getDocPack(packId);
  if (!pack) return 0;
  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch { return 0; }

  // Collect unique model strings across all equipment tables
  const models = new Set();
  for (const tbl of ['cameras', 'backhauls', 'switches']) {
    const rows = Array.isArray(data[tbl]) ? data[tbl] : [];
    for (const r of rows) {
      const m = (r.model || r.mpn || '').trim();
      if (m) models.add(m);
    }
  }
  if (!models.size) return 0;

  const existingPaths = new Set(
    db.listDocPackFiles(packId)
      .filter(f => f.external_path)
      .map(f => f.external_path)
  );

  let attached = 0;
  for (const model of models) {
    const ds = lookupDatasheet(model);
    if (!ds) continue;
    if (existingPaths.has(ds.absPath)) continue;
    db.addDocPackFile({
      packId,
      kind: 'datasheet',
      filename: null,
      originalName: ds.original + '.pdf',
      mime: 'application/pdf',
      size: (() => { try { return fs.statSync(ds.absPath).size; } catch { return 0; } })(),
      caption: ds.mfr,
      note: `דף מוצר עבור ${model}`,
      visibility: 'client',
      contributor: contributor || '(export-sweep)',
      sortOrder: Date.now() % 1_000_000,
      externalPath: ds.absPath,
    });
    existingPaths.add(ds.absPath);
    attached++;
  }
  return attached;
}

module.exports = {
  buildContext,
  generateDocPack,
  dryRenderAllTemplates,
  fileDiskPath,
  packDir,
  buildDatasheetIndex,
  lookupDatasheet,
  searchDatasheets,
  sweepAndAttachDatasheets,
  UPLOADS_DIR,
  TEMPLATES_DIR,
  DS_PATH,
};
