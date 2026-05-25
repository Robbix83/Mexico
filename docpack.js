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
const PizZip          = require('pizzip');
const Docxtemplater   = require('docxtemplater');
const ImageModule     = require('docxtemplater-image-module-free');
const archiver        = require('archiver');
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
    getSize(_img, _tagValue, tagName) {
      if (tagName && /diagram|plan/i.test(tagName)) return [620, 380];
      return [560, 380]; // default photo size
    },
  };
}

/**
 * buildContext(pack, files) — produces the placeholder context for docxtemplater.
 * Defensive against missing fields so the template never throws on an empty pack.
 */
function buildContext(pack, files) {
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

  // Appendix = every client-visible PDF (uploaded or auto-attached datasheet).
  // The Word doc lists their names; the actual PDFs are packed in the ZIP alongside.
  const appendixFiles = allFiles
    .filter(f => f.kind === 'datasheet' || f.kind === 'pdf' || /\.pdf$/i.test(f.original_name || ''))
    .map(f => ({
      name: f.original_name || (f.external_path ? path.basename(f.external_path) : f.filename),
      kind: f.kind === 'datasheet' ? 'דף מוצר' : 'מסמך',
    }));

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
    appendix_files: appendixFiles,
    // Useful flags for conditional sections inside the template
    has_cameras:   cameras.length     > 0,
    has_backhauls: backhauls.length   > 0,
    has_switches:  switches.length    > 0,
    has_photos:    photoRows.length   > 0,
    has_network_diagram: !!network,
    has_site_plan:       !!sitepl,
    has_appendix:  appendixFiles.length > 0,
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
 * renderDocx(packId) — renders just the .docx file (no ZIP), returns a Buffer.
 * Internal use by generateDocPack (and the dry-render check).
 */
function renderDocx(packId) {
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
  const files   = db.listDocPackFiles(packId);
  const context = buildContext(pack, files);

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
}

/**
 * generateDocPack(packId) — produces the client-delivery ZIP containing:
 *   <pack name>.docx           — the Word document (filtered to client visibility)
 *   appendix/<datasheet>.pdf   — every client-visible PDF (uploaded + auto-attached)
 *
 * Returns a Promise<Buffer>. Streaming the archive into an in-memory buffer keeps
 * the response shape identical to before (single Buffer → res.end(buf)).
 */
function generateDocPack(packId) {
  return new Promise((resolve, reject) => {
    let docxBuf;
    try { docxBuf = renderDocx(packId); }
    catch (e) { return reject(e); }

    const pack  = db.getDocPack(packId);
    const files = db.listDocPackFiles(packId)
      .filter(f => (f.visibility || 'client') === 'client');

    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    archive.on('end',  () => resolve(Buffer.concat(chunks)));
    archive.on('warning', w => { if (w.code !== 'ENOENT') console.warn('[docpack zip]', w); });
    archive.on('error', err => reject(err));

    const docName = (pack.name || 'תיק תיעוד') + '.docx';
    archive.append(docxBuf, { name: docName });

    const seen = new Set(); // dedupe by archive entry name
    for (const f of files) {
      // Only PDFs (or anything that looks like one) go into appendix/
      const isPdf =
        f.kind === 'datasheet' ||
        f.kind === 'pdf' ||
        (f.mime && /pdf/i.test(f.mime)) ||
        /\.pdf$/i.test(f.original_name || '');
      if (!isPdf) continue;

      const src = f.filename ? fileDiskPath(f.pack_id, f.filename) : f.external_path;
      if (!src || !fs.existsSync(src)) continue;

      let entryName = 'appendix/' + (f.original_name || path.basename(src));
      // Dedupe — same model may appear in multiple equipment rows
      let n = 2;
      const base = entryName.replace(/\.pdf$/i, '');
      while (seen.has(entryName)) { entryName = `${base} (${n}).pdf`; n++; }
      seen.add(entryName);

      archive.file(src, { name: entryName });
    }

    archive.finalize();
  });
}

/**
 * dryRenderAllTemplates() — boot-time sanity check; renders every template
 * in TEMPLATES_DIR with empty sample data so we catch malformed templates
 * before the first user request. Logs results; does not throw.
 */
function dryRenderAllTemplates() {
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
      doc.render(buildContext(samplePack, []));
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

module.exports = {
  buildContext,
  generateDocPack,
  renderDocx,
  dryRenderAllTemplates,
  fileDiskPath,
  packDir,
  buildDatasheetIndex,
  lookupDatasheet,
  searchDatasheets,
  UPLOADS_DIR,
  TEMPLATES_DIR,
  DS_PATH,
};
